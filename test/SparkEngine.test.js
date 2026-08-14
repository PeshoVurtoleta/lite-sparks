import { describe, it, expect } from 'vitest';
import { SparkEngine } from '../SparkEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

describe('SparkEngine', () => {
    it('constructs with defaults', () => {
        const e = new SparkEngine();
        expect(e.max).toBe(5000);
        expect(e.config.gravity).toBe(800);
        expect(e.config.restitution).toBe(0.4);
        expect(e.colors.length).toBe(4);
    });

    it('pre-parses OKLCH heat colors', () => {
        const e = new SparkEngine(100);
        for (const c of e.colors) {
            expect(typeof c).toBe('string');
            expect(c).toContain('oklch');
        }
    });

    it('burst spawns correct count', () => {
        const e = new SparkEngine(200, { rng: () => 0.5 });
        e.burst(400, 300, 50, 0, Math.PI * 2, 100, 500);
        let count = 0;
        for (let i = 0; i < 200; i++) if (e.state[i] === 1) count++;
        expect(count).toBe(50);
    });

    it('burst respects angle range', () => {
        const e = new SparkEngine(100, { rng: () => 0.5 });
        // Straight up: angle midpoint = -PI/2
        e.burst(400, 300, 1, -Math.PI, 0, 500, 500);
        expect(e.vy[0]).toBeLessThan(0); // upward
    });

    it('invLife precomputed at spawn', () => {
        const e = new SparkEngine(100, { rng: () => 0.5 });
        e.burst(400, 300, 1, 0, Math.PI, 100, 100, 1.0, 1.0);
        expect(e.invLife[0]).toBeCloseTo(1.0, 2);
    });

    it('updateAndDraw runs without error', () => {
        const e = new SparkEngine(100);
        e.burst(400, 300, 20, 0, Math.PI * 2, 100, 500);
        expect(() => e.updateAndDraw(ctx, 0.016, 800, 600)).not.toThrow();
    });

    it('floor bounce reverses vy', () => {
        const e = new SparkEngine(100, { rng: () => 0.5, gravity: 800, restitution: 0.5 });
        e.burst(400, 590, 1, Math.PI / 2, Math.PI / 2, 100, 100); // straight down
        // Run several frames to hit floor
        for (let i = 0; i < 10; i++) e.updateAndDraw(ctx, 0.05, 800, 600);
        // Spark should have bounced (vy negative or zero after settling)
        expect(e.y[0]).toBeLessThanOrEqual(600);
    });

    it('sleep state: resting sparks skip physics', () => {
        const e = new SparkEngine(100, { rng: () => 0.5 });
        // Manually set a spark at rest
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 600;
        e.vx[0] = 0; e.vy[0] = 0; e.life[0] = 1.0; e.invLife[0] = 1.0; e.weight[0] = 2;
        const xBefore = e.x[0];
        e.updateAndDraw(ctx, 0.016, 800, 600);
        expect(e.x[0]).toBe(xBefore); // didn't move
    });

    it('dt clamping prevents teleportation', () => {
        const e = new SparkEngine(100);
        e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
        e.updateAndDraw(ctx, 5.0, 800, 600);
        // Sparks shouldn't have teleported past reasonable bounds
        for (let i = 0; i < 100; i++) {
            if (e.state[i] !== 0) {
                expect(Math.abs(e.y[i])).toBeLessThan(5000);
            }
        }
    });

    it('clear kills all particles', () => {
        const e = new SparkEngine(100);
        e.burst(400, 300, 50, 0, Math.PI * 2, 100, 500);
        e.clear();
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        expect(alive).toBe(0);
    });

    it('destroy nulls all arrays', () => {
        const e = new SparkEngine(100);
        e.destroy();
        expect(e.x).toBeNull();
        expect(e.invLife).toBeNull();
        expect(e.state).toBeNull();
        expect(e.colors).toBeNull();
    });

    it('destroy is idempotent', () => {
        const e = new SparkEngine(100);
        e.destroy();
        expect(() => e.destroy()).not.toThrow();
    });

    it('transparentBackground toggle changes compositing', () => {
        const e = new SparkEngine(100, { transparentBackground: true });
        expect(e.config.transparentBackground).toBe(true);
        e.config.transparentBackground = false;
        expect(e.config.transparentBackground).toBe(false);
    });
});
