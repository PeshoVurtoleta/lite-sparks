/**
 * @zakkster/lite-sparks v1.1.0
 * Zero-GC, SoA Spark & Debris Engine
 * Features vector velocity stretching, floor restitution, and a precomputed thermodynamic heat gradient.
 * Supports dark mode (additive blending) and light mode (source-over).
 */

import { toCssOklch } from '@zakkster/lite-color';

export const VERSION = '1.1.0';

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

        this._destroyed = false;
    }

    burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin = 0.5, lifeMax = 1.5) {
        if (this._destroyed) return;
        // S-02 count door (cold path): NaN/Infinity/<1 -> 0, and count|0 floors
        // 1.5 -> 1. Fail closed -- a hostile count is a no-op, not a full-pool fill.
        count = count >= 1 ? (count | 0) : 0;
        if (count === 0) return;
        let spawned = 0;

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) {
                this.state[i] = 1;
                this.x[i] = x;
                this.y[i] = y;

                const angle = angleMin + this.config.rng() * (angleMax - angleMin);
                const speed = speedMin + this.config.rng() * (speedMax - speedMin);

                this.vx[i] = Math.cos(angle) * speed;
                this.vy[i] = Math.sin(angle) * speed;

                // S-05 (spawn, cold path): a spark with exactly zero speed has
                // vx===vy===0, which the hot-loop sleep check reads as "at rest"
                // and freezes it mid-air forever. Seed a tiny vy so gravity
                // engages and it falls. The hot-loop check stays two comparisons.
                if (this.vx[i] === 0 && this.vy[i] === 0) this.vy[i] = 1e-3;

                // S-11 (spawn, cold path): clamp life away from 0 so invLife is
                // never Infinity and colorIdx is never NaN. Also catches an
                // inverted lifeMin/lifeMax that would compute a negative life.
                let life = lifeMin + this.config.rng() * (lifeMax - lifeMin);
                if (life < 1e-4) life = 1e-4;
                this.life[i] = life;
                // -> Precompute the inverse for the render loop
                this.invLife[i] = 1.0 / life;
                this.weight[i] = 1.0 + this.config.rng() * 3.0;

                if (++spawned >= count) return;
            }
        }
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

        // S-04 dt-independent friction: the per-frame retention factor is
        // pow(friction, dt*60), hoisted ONCE. At dt=1/60, dt*60===1 and
        // pow(f,1)===f exactly, so 60fps output is byte-identical to v1.0.2.
        const f = Math.pow(this.config.friction, dt * 60);
        // S-10 floorY: null means "use h" (null is not zero). Hoisted once; the
        // per-spark weight/2 offset stays in the loop.
        const floorBase = this.config.floorY == null ? h : this.config.floorY;

        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = this.config.transparentBackground ? 'source-over' : 'lighter';

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) continue;

            this.life[i] -= dt;
            if (this.life[i] <= 0) {
                this.state[i] = 0;
                continue;
            }

            // -> Sleep State: Physics are completely bypassed if the particle rests
            if (this.vx[i] !== 0 || this.vy[i] !== 0) {
                this.vy[i] += this.config.gravity * dt;

                this.vx[i] *= f;
                this.vy[i] *= f;

                this.x[i] += this.vx[i] * dt;
                this.y[i] += this.vy[i] * dt;

                const floorY = floorBase - (this.weight[i] / 2);

                if (this.y[i] > floorY) {
                    this.y[i] = floorY;
                    this.vy[i] *= -this.config.restitution;
                    this.vx[i] *= this.config.floorFriction;

                    if (Math.abs(this.vy[i]) < 20) this.vy[i] = 0;

                    if (this.vy[i] === 0 && Math.abs(this.vx[i]) < 5) {
                        this.vx[i] = 0;
                    }
                }
            }

            // S-06 post-move X-cull with a 200px margin. Reading the post-move
            // position (a sleeping spark's x is unchanged, so this is equivalent
            // for it) and widening to the margin lets a stretched tail finish
            // drawing before head+tail clear the edge. Life bounds Y -- no Y cull.
            if (this.x[i] < -CULL_MARGIN || this.x[i] > w + CULL_MARGIN) {
                this.state[i] = 0;
                continue;
            }

            // -> Fast Index Calculation (Multiplication + Branchless Clamp)
            let colorIdx = Math.floor((this.life[i] * this.invLife[i]) * this._colorLen);
            colorIdx = colorIdx < 0 ? 0 : colorIdx >= this._colorLen ? this._colorLen - 1 : colorIdx;

            // -> Optimized Pipeline (Math first, Canvas second)
            const tailX = this.x[i] - this.vx[i] * this.config.stretch;
            const tailY = this.y[i] - this.vy[i] * this.config.stretch;

            ctx.beginPath();
            ctx.moveTo(this.x[i], this.y[i]);
            ctx.lineTo(tailX, tailY);

            ctx.lineWidth = this.weight[i];
            ctx.strokeStyle = this.colors[colorIdx];
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
    }
}