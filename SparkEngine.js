/**
 * @zakkster/lite-sparks v1.4.1
 * Zero-GC, SoA Spark & Debris Engine
 * Features vector velocity stretching, floor restitution, and a precomputed thermodynamic heat gradient.
 * Supports dark mode (additive blending) and light mode (source-over).
 */

import { toCssOklch } from '@zakkster/lite-color';

export const VERSION = '1.4.1';

// S-06: post-move X-cull margin. A velocity-stretched tail can trail up to this
// many px behind the head, so a spark keeps drawing until head+tail clear the
// margin -- killing the exact-edge tail pop of the old fused pre-move cull.
const CULL_MARGIN = 200;

// S-13 air forces. GUST_HZ is the gust oscillator's angular frequency: TAU/3
// rad/s, a 3-second period. TURB_K scales each spark's invLife into its
// turbulence phase; at >= 1000 the 1/life spread dominates the shared clock so
// two near-equal-life sparks wander in different directions (ADR 0007/0008).
const TAU = Math.PI * 2;
const GUST_HZ = TAU / 3;
const TURB_K = 1000;

// S-14 vortex clamp. VORTEX_MAX_ACCEL caps EACH AXIS of the combined
// radial (attract) + tangential (swirl) vortex acceleration at +/-4000 px/s^2 --
// 5x the default gravity (800). The vortex direction is normalized, so |accel|
// is bounded by |attract|+|swirl| already; the clamp bounds a HOSTILE scalar
// (e.g. attract=-1e9, or the accumulation of a very large one over many frames)
// so it can never fling a spark off-screen in a frame or run velocity out to a
// non-finite value. Fail closed on the config door (ADR 0010).
const VORTEX_MAX_ACCEL = 4000;

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
            drag: null,
            wind: 0,
            gust: 0,
            turbulence: 0,
            // S-14 containment (cold path). Walls are position clamps; null means
            // "no wall" on that side (null is not zero -- a wall AT 0 is a real
            // edge). Vortex scalars default 0 (off). attractX/attractY are the
            // vortex center, read ONLY when the vortex gate is live, so they
            // default to 0 (the caller sets them alongside attract) -- no runtime
            // "center" is invented in the cold path (ADR 0009/0010).
            wallLeft: null,
            wallRight: null,
            ceiling: null,
            attract: 0,
            swirl: 0,
            attractX: 0,
            attractY: 0,
            // S-15 debris vocabulary (cold path). onBounce is a floor-contact
            // hook called with primitives only (x, post-bounce vx, weight); null
            // means "no hook" (null is not zero -- a function is required to
            // fire). onBounceMinSpeed gates it on the PRE-bounce downward speed.
            // scaleTo/fadeOut drive the per-particle enveloped render lane;
            // scaleTo 1 + fadeOut 0 is the off default that keeps the bin-batched
            // lane byte-identical to v1.3.1 (ADR 0011/0012/0013).
            onBounce: null,
            onBounceMinSpeed: 0,
            scaleTo: 1,
            fadeOut: 0,
            transparentBackground: false,
            autoClear: true,
            floorY: null,
            heatColors: DEFAULT_HEAT,
            rng: Math.random,
            ...config
        };

        // S-13 fail-closed air knobs (cold path): a non-finite wind/gust/
        // turbulence is treated as OFF, sanitized ONCE here so the hot loop never
        // sees NaN/Infinity. Otherwise `wind=NaN` -> `NaN!==0` true -> aero true
        // -> `vx += (NaN+..)*dt` NaNs every live moving spark (the S-01 whole-pool
        // poison class through the config door). Zero hot bytes (ADR 0008).
        if (!Number.isFinite(this.config.wind)) this.config.wind = 0;
        if (!Number.isFinite(this.config.gust)) this.config.gust = 0;
        if (!Number.isFinite(this.config.turbulence)) this.config.turbulence = 0;

        // S-13 drag alias (cold path): `drag` is a friendlier name for the
        // air-friction retention factor. When provided (!= null; null is not
        // zero) AND finite it OVERRIDES `friction`, so the hot loop keeps reading
        // exactly one knob -- no new hot read (ADR 0007). A non-finite drag is
        // ignored (friction keeps its default/explicit value) so it can never
        // reach `pow(NaN, dt*60)` and NaN the pool even with aero off.
        if (this.config.drag != null && Number.isFinite(this.config.drag)) {
            this.config.friction = this.config.drag;
        }

        // S-14 fail-closed containment knobs (cold path). Walls: a non-finite
        // bound -> null ("no wall"), so `walls` stays off and the hot clamp is
        // byte-identical dead; null is not zero, so a wall AT 0 (finite) is
        // honoured. Vortex scalars: a non-finite attract/swirl/center -> 0.
        // A non-finite attract would flip the `attract!==0` gate ON and feed
        // `vx += NaN`, re-opening the S-01 whole-pool poison class through the
        // config door (the same hazard the aero knobs close, ADR 0008). Sanitized
        // ONCE here so the hot loop only ever sees finite operands. Zero hot bytes.
        if (!Number.isFinite(this.config.wallLeft)) this.config.wallLeft = null;
        if (!Number.isFinite(this.config.wallRight)) this.config.wallRight = null;
        if (!Number.isFinite(this.config.ceiling)) this.config.ceiling = null;
        if (!Number.isFinite(this.config.attract)) this.config.attract = 0;
        if (!Number.isFinite(this.config.swirl)) this.config.swirl = 0;
        if (!Number.isFinite(this.config.attractX)) this.config.attractX = 0;
        if (!Number.isFinite(this.config.attractY)) this.config.attractY = 0;

        // S-15 fail-closed debris knobs (cold path). onBounce must be a function
        // to fire -- any non-function (including undefined) collapses to null so
        // the hot floor-branch guard `onBounce !== null` is byte-identical dead at
        // the default. The three numerics are coerced BEFORE any hot read:
        // scaleTo=NaN would make `NaN!==1` true and flip the enveloped lane ON
        // (feeding NaN widths to every stroke -- the S-01 poison class through the
        // config door), so NaN->1; fadeOut=NaN would make `NaN!==0` true, so
        // NaN->0; onBounceMinSpeed=NaN->0. Zero hot bytes (ADR 0012/0013).
        if (typeof this.config.onBounce !== 'function') this.config.onBounce = null;
        if (!Number.isFinite(this.config.onBounceMinSpeed)) this.config.onBounceMinSpeed = 0;
        if (!Number.isFinite(this.config.scaleTo)) this.config.scaleTo = 1;
        if (!Number.isFinite(this.config.fadeOut)) this.config.fadeOut = 0;

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

        // S-13 engine clock: total simulated dt, advanced once per frame in the
        // cold preheader. Drives the gust oscillator + turbulence phase (ADR 0008).
        this._elapsed = 0;

        this._destroyed = false;
    }

    burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin = 0.5, lifeMax = 1.5) {
        if (this._destroyed) return;
        // S-02 count door (cold path): NaN/Infinity/<1 -> 0, and count|0 floors
        // 1.5 -> 1. Fail closed -- a hostile count is a no-op, not a full-pool fill.
        count = count >= 1 ? (count | 0) : 0;
        if (count === 0) return;

        // S-16 burst finiteness door (cold path). The six cone/speed/life scalars
        // are coerced ONCE here, AFTER the S-02 count door confirmed there is work
        // to do and BEFORE the per-particle spawn loop reads them, so the hot body
        // stays byte-identical and a VALID (all-finite) burst skips the coercion
        // entirely -- the rng sequence, and every committed fingerprint, is
        // untouched. A hostile scalar is the S-01 whole-pool poison class through
        // the burst() door: angleMin=NaN -> `angle = NaN + rng()*(..)` -> cos/sin
        // NaN -> vx/vy NaN on every spark this burst spawns. Each min/max is
        // coerced INDEPENDENTLY (an inverted or half-NaN range is not "off", it is
        // a real range with one hostile end). Fail-closed fallbacks: angle 0 is +x
        // (a definite direction, not a guess); speed 0 rides the S-05 epsilon
        // below (vx===vy===0 -> a tiny vy so gravity engages), so a NaN speed
        // becomes a falling ember, not a frozen NaN; lifeMin/lifeMax fall back to
        // the documented positional defaults (0.5 / 1.5). Zero rng draws, zero hot
        // bytes (ADR 0014).
        if (!Number.isFinite(angleMin)) angleMin = 0;
        if (!Number.isFinite(angleMax)) angleMax = 0;
        if (!Number.isFinite(speedMin)) speedMin = 0;
        if (!Number.isFinite(speedMax)) speedMax = 0;
        if (!Number.isFinite(lifeMin)) lifeMin = 0.5;
        if (!Number.isFinite(lifeMax)) lifeMax = 1.5;

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
            // inverted lifeMin/lifeMax that would compute a negative life. The
            // NaN-safe `!(life >= 1e-4)` form (S-16) also closes a non-finite
            // life that slips the door: a plain `life < 1e-4` is FALSE for NaN,
            // so a NaN would pass through; `!(life >= 1e-4)` is TRUE for NaN, so
            // it clamps to 1e-4. Same instruction count.
            let life = lifeMin + rng() * (lifeMax - lifeMin);
            if (!(life >= 1e-4)) life = 1e-4;
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

        // S-13 air forces (cold preheader): advance the engine clock, then hoist
        // the per-frame air constants. gustNow samples the gust oscillator ONCE
        // this frame; aero is the single hot-loop gate -- every knob 0 -> aero
        // false -> the per-particle body is byte-identical to v1.2.0 (ADR 0008).
        this._elapsed += dt;
        const el = this._elapsed;
        const wind = cfg.wind;
        const turb = cfg.turbulence;
        const gust = cfg.gust;
        const gustNow = gust !== 0 ? Math.sin(el * GUST_HZ) * gust : 0;

        // S-14 vortex (folded into the SAME aero gate). attract pulls each moving
        // spark toward (attractX, attractY); swirl adds a perpendicular tangential
        // push. Both are per-spark (they depend on the spark's own position) so,
        // unlike gust, they cannot be pre-sampled once -- but they ride the ONE
        // `if (aero)` branch, adding no new per-particle gate (ADR 0010).
        const attract = cfg.attract;
        const swirl = cfg.swirl;
        const attractX = cfg.attractX;
        const attractY = cfg.attractY;
        const aero = wind !== 0 || gustNow !== 0 || turb !== 0 || attract !== 0 || swirl !== 0;

        // S-14 walls (its own hoisted gate, one hot `if (walls)`). A null bound is
        // "no wall" (null is not zero); `walls` is false when all three are null,
        // so the clamp below is byte-identical dead at the default (ADR 0009).
        const wallLeft = cfg.wallLeft;
        const wallRight = cfg.wallRight;
        const ceiling = cfg.ceiling;
        const walls = wallLeft != null || wallRight != null || ceiling != null;

        // S-15 debris hooks (cold preheader). onBounce is the floor-contact hook
        // (null -> the hot floor-branch guard is dead); obMin gates it on the
        // pre-bounce downward speed. scaleTo/fadeOut drive the enveloped render
        // lane; `enveloped` is the single render gate -- scaleTo 1 && fadeOut 0 ->
        // false -> the bin-batched lane below is byte-identical to v1.3.1. Both
        // guards are false/null at the default, so the per-particle body and the
        // batched render are unchanged (ADR 0012/0013).
        const onBounce = cfg.onBounce;
        const obMin = cfg.onBounceMinSpeed;
        const scaleTo = cfg.scaleTo;
        const fadeOut = cfg.fadeOut;
        const enveloped = scaleTo !== 1 || fadeOut !== 0;

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

                // S-13 air forces (hot, single hoisted gate). Skipped entirely
                // when every knob is 0 (aero false) -- the aero-off body is
                // byte-identical to v1.2.0. Wind + gust push one shared
                // horizontal field; turbulence is a per-spark curl whose phase
                // is seeded by invLife (rng-derived, unique per spark), so two
                // sparks wander apart. No new column, no new draw op (ADR 0008).
                if (aero) {
                    if (wind !== 0 || gustNow !== 0) vxs[i] += (wind + gustNow) * dt;
                    if (turb !== 0) {
                        const p = invLifeA[i] * TURB_K + el;
                        vxs[i] += Math.cos(p) * turb * dt;
                        vys[i] += Math.sin(p) * turb * dt;
                    }
                    // S-14 vortex: radial pull toward (attractX, attractY) scaled
                    // by `attract`, plus a perpendicular tangential push scaled by
                    // `swirl` -- tangent is (-dy, dx)/dist, a 90deg rotation of the
                    // radial unit vector. dist === 0 is skipped (fail closed: the
                    // direction is undefined at the center, and it avoids a divide-
                    // by-zero). Each axis is clamped to +/-VORTEX_MAX_ACCEL so a
                    // hostile scalar can never go non-finite or teleport a spark
                    // (ADR 0010). Zero allocation -- every operand is a hoisted
                    // scalar or an SoA read; no temp object, no array.
                    if (attract !== 0 || swirl !== 0) {
                        const dx = attractX - xs[i];
                        const dy = attractY - ys[i];
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist !== 0) {
                            const inv = 1 / dist;
                            const nx = dx * inv, ny = dy * inv;
                            let ax = attract * nx - swirl * ny;
                            let ay = attract * ny + swirl * nx;
                            ax = ax < -VORTEX_MAX_ACCEL ? -VORTEX_MAX_ACCEL : ax > VORTEX_MAX_ACCEL ? VORTEX_MAX_ACCEL : ax;
                            ay = ay < -VORTEX_MAX_ACCEL ? -VORTEX_MAX_ACCEL : ay > VORTEX_MAX_ACCEL ? VORTEX_MAX_ACCEL : ay;
                            vxs[i] += ax * dt;
                            vys[i] += ay * dt;
                        }
                    }
                }

                xs[i] += vxs[i] * dt;
                ys[i] += vys[i] * dt;

                const floorY = floorBase - (weightA[i] / 2);

                if (ys[i] > floorY) {
                    ys[i] = floorY;
                    // S-15 onBounce: capture the PRE-bounce vy (downward speed at
                    // contact, positive) before restitution flips it, so the hook
                    // can gate on impact strength (ADR 0012).
                    const pvy = vys[i];
                    vys[i] *= -restitution;
                    vxs[i] *= floorFriction;

                    if (Math.abs(vys[i]) < 20) vys[i] = 0;

                    if (vys[i] === 0 && Math.abs(vxs[i]) < 5) {
                        vxs[i] = 0;
                    }

                    // S-15 hook fires AFTER the floor resolves, on the post-bounce
                    // vx and the spark's weight -- primitives only, no allocation.
                    // Gated by the pre-bounce downward speed (pvy > obMin) so a
                    // gentle settle does not fire it. null default -> byte-identical
                    // dead. NO try/catch: a throwing hook must surface, not be
                    // swallowed mid-frame (ADR 0012).
                    if (onBounce !== null && pvy > obMin) onBounce(xs[i], vxs[i], weightA[i]);
                }

                // S-14 walls: reflect velocity and contain position at each set
                // bound. Placed AFTER the floor block (so a floor-rested spark's
                // clamped position wins) and INSIDE the moving gate (S-05): walls
                // never wake a resting ember, mirroring "wind does not wake
                // resting embers" (ADR 0008). The clamp is AFTER integration, so a
                // spark that crossed a wall THIS frame is pulled back onto it and
                // its inward velocity reflected out (ADR 0009). vx at the side
                // walls, vy at the ceiling; the sign test avoids re-flipping a
                // spark already moving away. `walls` is false at the default -> the
                // whole block is byte-identical dead.
                if (walls) {
                    if (wallLeft != null && xs[i] < wallLeft) { xs[i] = wallLeft; if (vxs[i] < 0) vxs[i] = -vxs[i]; }
                    if (wallRight != null && xs[i] > wallRight) { xs[i] = wallRight; if (vxs[i] > 0) vxs[i] = -vxs[i]; }
                    if (ceiling != null && ys[i] < ceiling) { ys[i] = ceiling; if (vys[i] < 0) vys[i] = -vys[i]; }
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
        // S-15 render gate: `enveloped` (scaleTo!==1 || fadeOut!==0) selects a
        // per-particle stroke lane so each spark can carry its own life-driven
        // width scale and alpha fade. It draws the SAME segment geometry as the
        // batched lane -- head (hx,hy) to (hx - vx*stretch, hy - vy*stretch) --
        // one stroke per spark (the batching tradeoff, ADR 0013). At the default
        // (`enveloped` false) the ELSE branch is the v1.3.1 bin-batched lane,
        // byte-identical. The envelope factors derive from the remaining-life
        // ratio (lifeA*invLifeA, 0 rng): scale runs 1 (fresh) -> scaleTo (dying),
        // alpha runs 1 (fresh) -> 1-fadeOut (dying).
        if (enveloped) {
            for (let b = 0; b < nbins; b++) {
                const start = binStart[b];
                const end = binStart[b + 1];
                if (end === start) continue;

                ctx.strokeStyle = colors[b >> 2];
                for (let k = start; k < end; k++) {
                    const i = order[k];
                    const hx = xs[i], hy = ys[i];
                    const prog = lifeA[i] * invLifeA[i]; // remaining-life ratio [0,1]
                    ctx.lineWidth = weightA[i] * (scaleTo + (1 - scaleTo) * prog);
                    ctx.globalAlpha = 1 - fadeOut * (1 - prog);
                    ctx.beginPath();
                    ctx.moveTo(hx, hy);
                    ctx.lineTo(hx - vxs[i] * stretch, hy - vys[i] * stretch);
                    ctx.stroke();
                }
            }
            // Fail-closed restore: the enveloped lane is the only writer of
            // globalAlpha, so reset it to 1 before the next frame reads it.
            ctx.globalAlpha = 1;
        } else {
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

// S-15 upward emission direction (cold). Canvas y grows downward, so a negative
// sin points up; -TAU/4 is straight up. The presets and makeEmitter center their
// cones here.
const UP = -TAU / 4;

/**
 * S-15 spark presets (cold path). Each is a FROZEN object of the seven positional
 * burst fields (count, angleMin, angleMax, speedMin, speedMax, lifeMin, lifeMax).
 * `ember` additionally carries scaleTo/fadeOut HINTS -- these are engine-config
 * values (pass them to `new SparkEngine(max, { scaleTo, fadeOut })`), not burst
 * args, so `burstPreset` ignores them; they document the enveloped lane the
 * preset is designed for (ADR 0011/0013). Angles are in radians, up = -TAU/4.
 */
export const SPARK_PRESETS = Object.freeze({
    // Welding: a tight, near-vertical cone of fast, short-lived white-hot sparks.
    weld: Object.freeze({
        count: 40, angleMin: UP - 0.4, angleMax: UP + 0.4,
        speedMin: 300, speedMax: 900, lifeMin: 0.3, lifeMax: 0.9,
    }),
    // Grinding: a wide upward fan, medium speed and life.
    grind: Object.freeze({
        count: 30, angleMin: UP - 1.1, angleMax: UP + 1.1,
        speedMin: 200, speedMax: 700, lifeMin: 0.4, lifeMax: 1.1,
    }),
    // Impact: a full 360-degree radial burst, high speed, short life.
    impact: Object.freeze({
        count: 60, angleMin: 0, angleMax: TAU,
        speedMin: 150, speedMax: 800, lifeMin: 0.2, lifeMax: 0.7,
    }),
    // Ember: a gentle upward drift, slow and long-lived -- designed for the
    // enveloped lane (run the engine with the scaleTo/fadeOut hints below).
    ember: Object.freeze({
        count: 20, angleMin: UP - 0.6, angleMax: UP + 0.6,
        speedMin: 40, speedMax: 160, lifeMin: 1.2, lifeMax: 2.4,
        scaleTo: 0.2, fadeOut: 0.9,
    }),
});

/**
 * S-15 positional preset adapter (cold path). Reads a preset's fields and calls
 * engine.burst with them POSITIONALLY -- no spread, no temp array, no temp object
 * per call, so it allocates nothing (ADR 0011). A null/undefined preset is a
 * no-op (fail closed). Config-hint fields on the preset (scaleTo/fadeOut) are
 * ignored here -- they belong on the engine, not a burst.
 * @param {SparkEngine} engine
 * @param {number} x
 * @param {number} y
 * @param {object} preset One of SPARK_PRESETS (or a like-shaped object).
 */
export function burstPreset(engine, x, y, preset) {
    if (preset == null) return;
    engine.burst(
        x, y, preset.count,
        preset.angleMin, preset.angleMax,
        preset.speedMin, preset.speedMax,
        preset.lifeMin, preset.lifeMax
    );
}

/**
 * S-15 fractional-rate emitter (cold constructor, zero-alloc step). Returns a
 * descriptor holding a `carry` accumulator: each `step(engine, dt)` adds
 * `rate * dt` sparks-worth of fractional credit, spawns the integer part, and
 * keeps the remainder -- so a sub-frame rate (e.g. 2.5/frame) emits 2 or 3
 * sparks on alternating frames and averages exactly `rate` over time, unlike an
 * integer-per-frame emitter that would truncate the fraction away every frame
 * (ADR 0011). step calls engine.burst with derived cone/speed/life fields and
 * allocates nothing (every operand is a stored scalar or a stack local).
 *
 * Fail closed at construction: a non-finite/negative rate/speed/life -> 0
 * (an inert emitter that spawns nothing), a non-finite x/y/cone -> 0.
 *
 * @param {{x?:number,y?:number,rate?:number,cone?:number,speed?:number,life?:number}} opts
 * @returns {{x:number,y:number,rate:number,cone:number,speed:number,life:number,carry:number,step:(engine:SparkEngine,dt:number)=>void}}
 */
export function makeEmitter(opts) {
    const o = opts || {};
    const x = Number.isFinite(o.x) ? o.x : 0;
    const y = Number.isFinite(o.y) ? o.y : 0;
    const rate = Number.isFinite(o.rate) && o.rate > 0 ? o.rate : 0;
    const cone = Number.isFinite(o.cone) && o.cone > 0 ? o.cone : 0;
    const speed = Number.isFinite(o.speed) && o.speed > 0 ? o.speed : 0;
    const life = Number.isFinite(o.life) && o.life > 0 ? o.life : 0;
    return {
        x, y, rate, cone, speed, life, carry: 0,
        step(engine, dt) {
            // Fail closed: a non-positive/NaN dt or rate contributes nothing and
            // never poisons the carry accumulator (a NaN would stick forever).
            if (!(dt > 0) || !(this.rate > 0)) return;
            this.carry += this.rate * dt;
            const n = this.carry | 0;      // integer sparks to emit this step
            this.carry -= n;               // keep the fractional remainder
            if (n > 0) {
                engine.burst(
                    this.x, this.y, n,
                    UP - this.cone, UP + this.cone,
                    this.speed * 0.5, this.speed,
                    this.life * 0.5, this.life
                );
            }
        },
    };
}
