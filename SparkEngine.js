/**
 * @zakkster/lite-sparks v1.0.0
 * Zero-GC, SoA Spark & Debris Engine
 * Features vector velocity stretching, floor restitution, and a precomputed thermodynamic heat gradient.
 * Supports dark mode (additive blending) and light mode (source-over).
 */

import { toCssOklch } from '@zakkster/lite-color';

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
        this.invLife = new Float32Array(this.max); // ⚡ Multiplier cache for hyper-fast normalization
        this.weight = new Float32Array(this.max);
        this.state = new Uint8Array(this.max);

        this._destroyed = false;
    }

    burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin = 0.5, lifeMax = 1.5) {
        if (this._destroyed) return;
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

                this.life[i] = lifeMin + this.config.rng() * (lifeMax - lifeMin);
                // ⚡ Precompute the inverse for the render loop
                this.invLife[i] = 1.0 / this.life[i];
                this.weight[i] = 1.0 + this.config.rng() * 3.0;

                if (++spawned >= count) return;
            }
        }
    }

    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        if (dt > 0.1) dt = 0.1; // Guard against tab-backgrounding teleportation

        // Clear previous frame — sparks are velocity-stretched lines, not bloom dots
        ctx.clearRect(0, 0, w, h);

        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = this.config.transparentBackground ? 'source-over' : 'lighter';

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) continue;

            this.life[i] -= dt;
            if (this.life[i] <= 0 || this.x[i] < 0 || this.x[i] > w) {
                this.state[i] = 0;
                continue;
            }

            // ⚡ Sleep State: Physics are completely bypassed if the particle rests
            if (this.vx[i] !== 0 || this.vy[i] !== 0) {
                this.vy[i] += this.config.gravity * dt;

                this.vx[i] *= this.config.friction;
                this.vy[i] *= this.config.friction;

                this.x[i] += this.vx[i] * dt;
                this.y[i] += this.vy[i] * dt;

                const floorY = h - (this.weight[i] / 2);

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

            // ⚡ Fast Index Calculation (Multiplication + Branchless Clamp)
            let colorIdx = Math.floor((this.life[i] * this.invLife[i]) * this._colorLen);
            colorIdx = colorIdx < 0 ? 0 : colorIdx >= this._colorLen ? this._colorLen - 1 : colorIdx;

            // ⚡ Optimized Pipeline (Math first, Canvas second)
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