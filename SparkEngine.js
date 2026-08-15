/**
 * @zakkster/lite-sparks v1.2.0
 * Zero-GC, SoA Spark & Debris Engine
 * Features vector velocity stretching, floor restitution, and a precomputed thermodynamic heat gradient.
 * Supports dark mode (additive blending) and light mode (source-over).
 */

import { toCssOklch } from '@zakkster/lite-color';

export const VERSION = '1.2.0';

// S-06: post-move X-cull margin. A velocity-stretched tail can trail up to this
// many px behind the head, so a spark keeps drawing until head+tail clear the
// margin -- killing the exact-edge tail pop of the old fused pre-move cull.
const CULL_MARGIN = 200;

const DEFAULT_HEAT = [
    { l: 0.30, c: 0.20, h: 20 },   // Cold/Dying (Cherry Red)
    { l: 0.60, c: 0.25, h: 30 },   // Warm (Orange)
    { l: 0.85, c: 0.20, h: 70 },   // Hot (Yellow)
    { l: 0.98, c: 0.05, h: 90 },   // White Hot (Core)
];

export class SparkEngine {
    constructor(maxParticles = 5000, config = {}) {
        this.max = maxParticles;
        this.config = {
            gravity: 800,
            friction: 0.99,
            floorFriction: 0.85,
            restitution: 0.4,
            stretch: 0.04,
            transparentBackground: false,
            autoClear: true,
            floorY: null,
            heatColors: DEFAULT_HEAT,
            rng: Math.random,
            ...config
        };

        this.colors = this.config.heatColors.map(c => typeof c === 'string' ? c : toCssOklch(c));
        this._colorLen = this.colors.length;

        this.x = new Float32Array(this.max);
        this.y = new Float32Array(this.max);
        this.vx = new Float32Array(this.max);
        this.vy = new Float32Array(this.max);
        this.life = new Float32Array(this.max);
        this.invLife = new Float32Array(this.max); // -> Multiplier cache for hyper-fast normalization
        this.weight = new Float32Array(this.max);
        this.state = new Uint8Array(this.max);

        // S-07 (batched render, cold allocation): width bucket per spark, quantized
        // once at spawn into {0..3} so the hot loop bins by (colorIdx*4 + wBucket).
        this.wBucket = new Uint8Array(this.max);
        // Counting-sort scratch, allocated ONCE and reused every frame (never grown):
        // _order holds the draw-order index list; _binCount/_binStart are the per-bin
        // count + prefix-sum arrays. Bin count is _colorLen*4; the +1 slot is the
        // prefix-sum sentinel (total drawable = _binStart[nbins]).
        this._order = new Int32Array(this.max);
        this._binCount = new Int32Array(this._colorLen * 4 + 1);
        this._binStart = new Int32Array(this._colorLen * 4 + 1);

        // S-08 ring cursor: overwrite-oldest spawn (see decisions/0005-spawn.md).
        this._head = 0;
        // Diagnostic: slots touched by the last burst (cold path, torture witness).
        this._visits = 0;

        this._destroyed = false;
    }

    burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin = 0.5, lifeMax = 1.5) {
        if (this._destroyed) return;
        // S-02 count door (cold path): NaN/Infinity/<1 -> 0, and count|0 floors
        // 1.5 -> 1. Fail closed -- a hostile count is a no-op, not a full-pool fill.
        count = count >= 1 ? (count | 0) : 0;
        if (count === 0) return;

        const max = this.max;
        // S-08 (cold path): the pool holds at most `max` live sparks, so a burst
        // larger than the pool can only ever fill the pool. Cap the work at max --
        // conservation law min(count, max) -- keeping the ring O(count) not O(count^2).
        if (count > max) count = max;

        const state = this.state;
        const xs = this.x, ys = this.y, vxs = this.vx, vys = this.vy;
        const lifeA = this.life, invLifeA = this.invLife;
        const weightA = this.weight, wBucketA = this.wBucket;
        const rng = this.config.rng;

        let head = this._head;
        let visits = 0;
        for (let s = 0; s < count; s++) {
            // S-08 ring cursor (overwrite-oldest): advance one slot and take it,
            // alive or dead. No free-slot scan -- landing on a live spark evicts
            // the oldest, which is the O(1)-per-spawn tradeoff of ADR 0005.
            head = head + 1;
            if (head >= max) head = 0;
            visits++;
            const i = head;

            state[i] = 1;
            xs[i] = x;
            ys[i] = y;

            const angle = angleMin + rng() * (angleMax - angleMin);
            const speed = speedMin + rng() * (speedMax - speedMin);

            vxs[i] = Math.cos(angle) * speed;
            vys[i] = Math.sin(angle) * speed;

            // S-05 (spawn, cold path): a spark with exactly zero speed has
            // vx===vy===0, which the hot-loop sleep check reads as "at rest"
            // and freezes it mid-air forever. Seed a tiny vy so gravity
            // engages and it falls. The hot-loop check stays two comparisons.
            if (vxs[i] === 0 && vys[i] === 0) vys[i] = 1e-3;

            // S-11 (spawn, cold path): clamp life away from 0 so invLife is
            // never Infinity and colorIdx is never NaN. Also catches an
            // inverted lifeMin/lifeMax that would compute a negative life.
            let life = lifeMin + rng() * (lifeMax - lifeMin);
            if (life < 1e-4) life = 1e-4;
            lifeA[i] = life;
            // -> Precompute the inverse for the render loop
            invLifeA[i] = 1.0 / life;

            const weight = 1.0 + rng() * 3.0;
            weightA[i] = weight;
            // S-07 (spawn, cold path): quantize the 1..4px width into 4 buckets so
            // the hot loop never recomputes it. weight in [1,4) -> (weight-1)|0 in
            // {0,1,2}; the clamp guards a manually-seeded weight outside the range.
            let wb = (weight - 1) | 0;
            wb = wb < 0 ? 0 : wb > 3 ? 3 : wb;
            wBucketA[i] = wb;
        }
        this._head = head;
        this._visits = visits;
    }

    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        // S-01 dt door (cold path): reject NaN, -0, 0, and negatives before the
        // loop. Fail closed -- a bad dt is a silent no-op frame that leaves the
        // last good state on screen, never a NaN poisoning every live particle.
        if (!(dt > 0)) return;
        if (dt > 0.1) dt = 0.1; // Guard against tab-backgrounding teleportation

        // S-03 autoClear: default true clears the frame (sparks are velocity-
        // stretched lines, not bloom dots). autoClear:false draws over existing
        // pixels so sparks can layer over a game/scratch surface.
        if (this.config.autoClear) ctx.clearRect(0, 0, w, h);

        // S-09 hot-body hoisting: every per-frame invariant is read ONCE into a
        // loop-preheader local so the per-particle body touches no property. The
        // physics arithmetic and its intermediate Float32Array round-trips are
        // preserved exactly -- 60fps output stays byte-identical to v1.1.0.
        const cfg = this.config;
        const gravity = cfg.gravity;
        // S-04 dt-independent friction: pow(friction, dt*60), hoisted ONCE.
        const f = Math.pow(cfg.friction, dt * 60);
        const stretch = cfg.stretch;
        const restitution = cfg.restitution;
        const floorFriction = cfg.floorFriction;
        // S-10 floorY: null means "use h" (null is not zero). Hoisted once.
        const floorBase = cfg.floorY == null ? h : cfg.floorY;
        const colorLen = this._colorLen;
        const colors = this.colors;
        const max = this.max;

        const state = this.state;
        const xs = this.x, ys = this.y, vxs = this.vx, vys = this.vy;
        const lifeA = this.life, invLifeA = this.invLife, weightA = this.weight;
        const wBucketA = this.wBucket;
        const order = this._order;
        const binCount = this._binCount;
        const binStart = this._binStart;
        const nbins = colorLen * 4;
        const cullMin = -CULL_MARGIN;
        const cullMax = w + CULL_MARGIN;

        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = cfg.transparentBackground ? 'source-over' : 'lighter';

        // S-07 phase 1: physics + cull + per-bin count. The counting-sort scratch
        // is cleared in place (fill 0), never reallocated.
        for (let b = 0; b < nbins; b++) binCount[b] = 0;

        for (let i = 0; i < max; i++) {
            if (state[i] === 0) continue;

            lifeA[i] -= dt;
            if (lifeA[i] <= 0) {
                state[i] = 0;
                continue;
            }

            // -> Sleep State: Physics are completely bypassed if the particle rests
            if (vxs[i] !== 0 || vys[i] !== 0) {
                vys[i] += gravity * dt;

                vxs[i] *= f;
                vys[i] *= f;

                xs[i] += vxs[i] * dt;
                ys[i] += vys[i] * dt;

                const floorY = floorBase - (weightA[i] / 2);

                if (ys[i] > floorY) {
                    ys[i] = floorY;
                    vys[i] *= -restitution;
                    vxs[i] *= floorFriction;

                    if (Math.abs(vys[i]) < 20) vys[i] = 0;

                    if (vys[i] === 0 && Math.abs(vxs[i]) < 5) {
                        vxs[i] = 0;
                    }
                }
            }

            // S-06 post-move X-cull with a 200px margin. Reading the post-move
            // position (a sleeping spark's x is unchanged, so this is equivalent
            // for it) and widening to the margin lets a stretched tail finish
            // drawing before head+tail clear the edge. Life bounds Y -- no Y cull.
            if (xs[i] < cullMin || xs[i] > cullMax) {
                state[i] = 0;
                continue;
            }

            // -> Fast Index Calculation (Multiplication + Branchless Clamp)
            let colorIdx = Math.floor((lifeA[i] * invLifeA[i]) * colorLen);
            colorIdx = colorIdx < 0 ? 0 : colorIdx >= colorLen ? colorLen - 1 : colorIdx;

            // S-07: count this spark into its (color, width) bin.
            binCount[colorIdx * 4 + wBucketA[i]]++;
        }

        // S-07 phase 2: exclusive prefix sum -> per-bin start offsets, then scatter
        // each surviving spark's index into _order at its bin cursor. Only sparks
        // still state===1 after phase 1 (dead/culled are already cleared) count,
        // and life/invLife are unchanged so colorIdx recomputes identically.
        let acc = 0;
        for (let b = 0; b < nbins; b++) {
            binStart[b] = acc;
            acc += binCount[b];
            binCount[b] = binStart[b]; // reuse binCount as the running write cursor
        }
        binStart[nbins] = acc;

        for (let i = 0; i < max; i++) {
            if (state[i] === 0) continue;
            let colorIdx = Math.floor((lifeA[i] * invLifeA[i]) * colorLen);
            colorIdx = colorIdx < 0 ? 0 : colorIdx >= colorLen ? colorLen - 1 : colorIdx;
            const bin = colorIdx * 4 + wBucketA[i];
            order[binCount[bin]++] = i;
        }

        // S-07 phase 3: <= nbins (colors.length*4) state-setting passes. One
        // strokeStyle/lineWidth set per non-empty bin, all its segments batched
        // into a single path. Endpoints are byte-identical to v1.1.0; only the
        // draw order within a bin and the bucket-quantized width differ (ADR 0006).
        for (let b = 0; b < nbins; b++) {
            const start = binStart[b];
            const end = binStart[b + 1];
            if (end === start) continue;

            ctx.strokeStyle = colors[b >> 2];
            ctx.lineWidth = (b & 3) + 1;
            ctx.beginPath();
            for (let k = start; k < end; k++) {
                const i = order[k];
                const hx = xs[i], hy = ys[i];
                ctx.moveTo(hx, hy);
                ctx.lineTo(hx - vxs[i] * stretch, hy - vys[i] * stretch);
            }
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'source-over';
    }

    clear() {
        if (this._destroyed) return;
        this.state.fill(0);
        this.life.fill(0);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.clear();
        this.x = null; this.y = null; this.vx = null; this.vy = null;
        this.life = null; this.invLife = null; this.weight = null;
        this.state = null; this.colors = null;
        // S-07/S-08 scratch: released alongside the SoA columns, idempotently.
        this.wBucket = null; this._order = null; this._binCount = null; this._binStart = null;
    }
}
