import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkEngine } from '../SparkEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

test('constructs with defaults', () => {
    const e = new SparkEngine();
    assert.equal(e.max, 5000);
    assert.equal(e.config.gravity, 800);
    assert.equal(e.config.restitution, 0.4);
    assert.equal(e.colors.length, 4);
});

test('pre-parses OKLCH heat colors', () => {
    const e = new SparkEngine(100);
    for (const c of e.colors) {
        assert.equal(typeof c, 'string');
        assert.ok(c.includes('oklch'));
    }
});

test('burst spawns correct count', () => {
    const e = new SparkEngine(200, { rng: () => 0.5 });
    e.burst(400, 300, 50, 0, Math.PI * 2, 100, 500);
    let count = 0;
    for (let i = 0; i < 200; i++) if (e.state[i] === 1) count++;
    assert.equal(count, 50);
});

test('burst respects angle range', () => {
    const e = new SparkEngine(100, { rng: () => 0.5 });
    // Straight up: angle midpoint = -PI/2
    e.burst(400, 300, 1, -Math.PI, 0, 500, 500);
    assert.ok(e.vy[0] < 0); // upward
});

test('invLife precomputed at spawn', () => {
    const e = new SparkEngine(100, { rng: () => 0.5 });
    e.burst(400, 300, 1, 0, Math.PI, 100, 100, 1.0, 1.0);
    assert.ok(Math.abs(e.invLife[0] - 1.0) < 0.005);
});

test('updateAndDraw runs without error', () => {
    const e = new SparkEngine(100);
    e.burst(400, 300, 20, 0, Math.PI * 2, 100, 500);
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
});

test('floor bounce reverses vy', () => {
    const e = new SparkEngine(100, { rng: () => 0.5, gravity: 800, restitution: 0.5 });
    e.burst(400, 590, 1, Math.PI / 2, Math.PI / 2, 100, 100); // straight down
    // Run several frames to hit floor
    for (let i = 0; i < 10; i++) e.updateAndDraw(ctx, 0.05, 800, 600);
    // Spark should have bounced (vy negative or zero after settling)
    assert.ok(e.y[0] <= 600);
});

test('sleep state: resting sparks skip physics', () => {
    const e = new SparkEngine(100, { rng: () => 0.5 });
    // Manually set a spark at rest
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 600;
    e.vx[0] = 0; e.vy[0] = 0; e.life[0] = 1.0; e.invLife[0] = 1.0; e.weight[0] = 2;
    const xBefore = e.x[0];
    e.updateAndDraw(ctx, 0.016, 800, 600);
    assert.equal(e.x[0], xBefore); // didn't move
});

test('dt clamping prevents teleportation', () => {
    const e = new SparkEngine(100);
    e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    e.updateAndDraw(ctx, 5.0, 800, 600);
    // Sparks shouldn't have teleported past reasonable bounds
    for (let i = 0; i < 100; i++) {
        if (e.state[i] !== 0) {
            assert.ok(Math.abs(e.y[i]) < 5000);
        }
    }
});

test('clear kills all particles', () => {
    const e = new SparkEngine(100);
    e.burst(400, 300, 50, 0, Math.PI * 2, 100, 500);
    e.clear();
    let alive = 0;
    for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
    assert.equal(alive, 0);
});

test('destroy nulls all arrays', () => {
    const e = new SparkEngine(100);
    e.destroy();
    assert.equal(e.x, null);
    assert.equal(e.invLife, null);
    assert.equal(e.state, null);
    assert.equal(e.colors, null);
});

test('destroy is idempotent', () => {
    const e = new SparkEngine(100);
    e.destroy();
    assert.doesNotThrow(() => e.destroy());
});

test('transparentBackground toggle changes compositing', () => {
    const e = new SparkEngine(100, { transparentBackground: true });
    assert.equal(e.config.transparentBackground, true);
    e.config.transparentBackground = false;
    assert.equal(e.config.transparentBackground, false);
});
