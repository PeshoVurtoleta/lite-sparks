/**
 * @zakkster/lite-sparks -- S-15 "debris vocabulary" (v1.4.0) boundary suite.
 *
 * QA companion to the torture-tier T0/T6/T9 versions of the same laws
 * (test/torture/t0-laws.mjs Laws 14-16, test/torture/t9-controls.mjs Controls
 * F/G/H), written directly from the S5 ROADMAP ASSERTIONS at a size node:test
 * runs in milliseconds. Covers the four new config keys (onBounce,
 * onBounceMinSpeed, scaleTo, fadeOut) and the three new exports (SPARK_PRESETS,
 * burstPreset, makeEmitter) -- the surface the coder shipped untouched by any
 * pre-existing unit test file.
 *
 * Boundary matrix applied per new entry point where it is meaningful: 0, 1,
 * N-1, N, N+1, empty, null, undefined, NaN, -0, duplicate dispose,
 * dispose-during-iteration, re-entrant write, and adversarial cases the S5
 * planner did not enumerate (a partial/malformed preset object, and the
 * scaleTo=-0 vs fadeOut=-0 asymmetry in the `enveloped` gate).
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkEngine, SPARK_PRESETS, burstPreset, makeEmitter } from '../SparkEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}
function floatRng(seed) {
    const p = makePrng(seed);
    return () => p() / 4294967296;
}

function aliveCount(e) {
    let n = 0;
    for (let i = 0; i < e.max; i++) if (e.state[i] === 1) n++;
    return n;
}

function aliveFinite(e) {
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 1) continue;
        if (!(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]) &&
              Number.isFinite(e.vx[i]) && Number.isFinite(e.vy[i]) &&
              Number.isFinite(e.life[i]))) return false;
    }
    return true;
}

/** Snapshot every column of every slot for a byte-identical (Object.is) compare. */
function snapshot(e) {
    const rows = [];
    for (let i = 0; i < e.max; i++) {
        rows.push([e.state[i], e.x[i], e.y[i], e.vx[i], e.vy[i], e.life[i]]);
    }
    return rows;
}
function snapshotsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        for (let k = 0; k < a[i].length; k++) {
            if (!Object.is(a[i][k], b[i][k])) return false;
        }
    }
    return true;
}

/**
 * A ctx stub whose globalAlpha/lineWidth are accessors that record every
 * WRITE (not just the final value), so a test can prove the batched lane
 * never touches globalAlpha at all, vs. the enveloped lane touching it once
 * per live spark plus the fail-closed restore.
 */
function trackingCtx() {
    let alpha = 1, lw = 1;
    const alphaWrites = [];
    const lineWidthWrites = [];
    return {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        strokeStyle: '', lineCap: 'butt', globalCompositeOperation: 'source-over',
        get globalAlpha() { return alpha; },
        set globalAlpha(v) { alpha = v; alphaWrites.push(v); },
        get lineWidth() { return lw; },
        set lineWidth(v) { lw = v; lineWidthWrites.push(v); },
        alphaWrites, lineWidthWrites,
    };
}

// ===========================================================================
// PRESET DETERMINISM
// ===========================================================================

for (const key of ['weld', 'grind', 'impact', 'ember']) {
    test('S-15 preset determinism: ' + key + ' -- two seeded engines produce a byte-identical snapshot after N frames', () => {
        const preset = SPARK_PRESETS[key];
        const script = (e) => {
            for (let f = 0; f < 40; f++) {
                if ((f % 8) === 0) burstPreset(e, 400, 300, preset);
                e.updateAndDraw(ctx, 1 / 60, 800, 600);
            }
        };
        const a = new SparkEngine(128, { rng: floatRng(0xabc123) });
        const b = new SparkEngine(128, { rng: floatRng(0xabc123) });
        script(a); script(b);
        assert.ok(snapshotsEqual(snapshot(a), snapshot(b)),
            'preset ' + key + ' diverged between two identically-seeded engines');
    });
}

test('S-15 preset determinism witness: weld/grind/impact/ember do not all produce the same burst', () => {
    const snap = (preset) => {
        const e = new SparkEngine(128, { rng: floatRng(0xabc123) });
        burstPreset(e, 400, 300, preset);
        e.updateAndDraw(ctx, 1 / 60, 800, 600);
        return JSON.stringify(snapshot(e));
    };
    const s = { weld: snap(SPARK_PRESETS.weld), grind: snap(SPARK_PRESETS.grind), impact: snap(SPARK_PRESETS.impact), ember: snap(SPARK_PRESETS.ember) };
    assert.notEqual(s.weld, s.grind);
    assert.notEqual(s.grind, s.impact);
    assert.notEqual(s.impact, s.ember);
    assert.notEqual(s.weld, s.ember);
});

// ===========================================================================
// PRESET SHAPE
// ===========================================================================

test('S-15 preset shape: SPARK_PRESETS and every preset are frozen', () => {
    assert.ok(Object.isFrozen(SPARK_PRESETS));
    for (const key of ['weld', 'grind', 'impact', 'ember']) {
        assert.ok(Object.isFrozen(SPARK_PRESETS[key]), key + ' is not frozen');
    }
});

test('S-15 preset shape: burstPreset spawns exactly preset.count sparks into an ample pool', () => {
    for (const key of ['weld', 'grind', 'impact', 'ember']) {
        const preset = SPARK_PRESETS[key];
        const e = new SparkEngine(512, { rng: () => 0.5 });
        burstPreset(e, 400, 300, preset);
        assert.equal(aliveCount(e), preset.count, key);
    }
});

test('S-15 preset shape: boundary N-1/N/N+1 -- pool smaller/equal/larger than preset.count clamps to min(count, max)', () => {
    const preset = SPARK_PRESETS.impact; // count: 60
    const nMinus1 = new SparkEngine(preset.count - 1, { rng: () => 0.5 });
    burstPreset(nMinus1, 400, 300, preset);
    assert.equal(aliveCount(nMinus1), preset.count - 1, 'N-1 pool');

    const nExact = new SparkEngine(preset.count, { rng: () => 0.5 });
    burstPreset(nExact, 400, 300, preset);
    assert.equal(aliveCount(nExact), preset.count, 'N pool');

    const nPlus1 = new SparkEngine(preset.count + 1, { rng: () => 0.5 });
    burstPreset(nPlus1, 400, 300, preset);
    assert.equal(aliveCount(nPlus1), preset.count, 'N+1 pool -- must not overfill');
});

test('S-15 preset shape: burstPreset(engine, x, y, null) is a fail-closed no-op', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    burstPreset(e, 400, 300, null);
    assert.equal(aliveCount(e), 0);
});

test('S-15 preset shape: burstPreset(engine, x, y, undefined) is a fail-closed no-op', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    burstPreset(e, 400, 300, undefined);
    assert.equal(aliveCount(e), 0);
});

test('S-15 preset shape: burstPreset with a non-object primitive (garbage) fails closed via the count door', () => {
    // 42.count / 'x'.count / true.count are all undefined -> engine.burst's
    // S-02 count door (`undefined >= 1` false) returns before touching angle/
    // speed/life, so a primitive "garbage" preset spawns nothing.
    for (const garbage of [42, 'x', true, [1, 2, 3]]) {
        const e = new SparkEngine(64, { rng: () => 0.5 });
        assert.doesNotThrow(() => burstPreset(e, 400, 300, garbage));
        assert.equal(aliveCount(e), 0, 'garbage=' + JSON.stringify(garbage));
    }
});

test('S-15 preset shape: burstPreset({}) (empty object, no count) fails closed', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    burstPreset(e, 400, 300, {});
    assert.equal(aliveCount(e), 0);
});

test('adversarial: burstPreset with a PARTIAL preset ({count} but no angle/speed fields) spawns count sparks AND fails closed -- the S-16 burst finiteness door coerces the undefined angle/speed args (decisions/0014)', () => {
    // burstPreset's JSDoc requires a "like-shaped" object (all 7 fields). A
    // caller violating that contract with a partial object passes `undefined`
    // for angleMin/angleMax/speedMin/speedMax. Pre-v1.4.1 the raw engine.burst()
    // API did not validate those (only count, life, and the config door were
    // guarded), so this produced NaN vx/vy -- a gap this test used to PIN as
    // documented-not-fixed. S-16 (v1.4.1) closed it: burst() now coerces each of
    // the six cone/speed/life args independently with Number.isFinite at entry
    // (undefined is non-finite -> 0), so a partial preset now FAILS CLOSED. This
    // is an intended test-semantics change, not a regression (decisions/0014).
    const e = new SparkEngine(64, { rng: () => 0.5 });
    burstPreset(e, 400, 300, { count: 5 }); // angleMin/Max, speedMin/Max: undefined
    assert.equal(aliveCount(e), 5, 'the count door alone gates spawn count');
    for (let i = 0; i < 64; i++) {
        if (e.state[i] !== 1) continue;
        assert.ok(Number.isFinite(e.vx[i]) && Number.isFinite(e.vy[i]),
            'a partial preset ({count} only) must now FAIL CLOSED: the S-16 door coerces the ' +
            'undefined angle/speed args to 0, so vx/vy stay finite (was NaN pre-v1.4.1; decisions/0014)');
    }
});

// ===========================================================================
// FRACTIONAL EMITTER EXACTNESS
// ===========================================================================

test('S-15 emitter exactness: rate=30 at dt=1/60 (0.5 sparks/frame) emits exactly floor(0.5*K) over K frames', () => {
    const K = 10;
    const e = new SparkEngine(64, { rng: () => 0.5 });
    const em = makeEmitter({ x: 400, y: 500, rate: 30, cone: 0.3, speed: 100, life: 100 });
    for (let f = 0; f < K; f++) { em.step(e, 1 / 60); e.updateAndDraw(ctx, 1 / 60, 800, 100000); }
    assert.equal(aliveCount(e), Math.floor(0.5 * K));
});

test('S-15 emitter exactness: the 0.5/frame cadence is exactly 1-every-2-frames (0 on odd steps, 1 on even)', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    const em = makeEmitter({ x: 400, y: 500, rate: 30, cone: 0.3, speed: 100, life: 100 });
    const perFrame = [];
    let prev = 0;
    for (let f = 0; f < 10; f++) {
        em.step(e, 1 / 60);
        e.updateAndDraw(ctx, 1 / 60, 800, 100000);
        const now = aliveCount(e);
        perFrame.push(now - prev);
        prev = now;
    }
    assert.deepEqual(perFrame, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
});

test('S-15 emitter exactness: cadence + final carry are bit-identical across 3 reruns with the same seed', () => {
    const run = () => {
        const e = new SparkEngine(64, { rng: () => 0.5 });
        const em = makeEmitter({ x: 400, y: 500, rate: 30, cone: 0.3, speed: 100, life: 100 });
        const perFrame = [];
        let prev = 0;
        for (let f = 0; f < 10; f++) {
            em.step(e, 1 / 60);
            e.updateAndDraw(ctx, 1 / 60, 800, 100000);
            const now = aliveCount(e);
            perFrame.push(now - prev);
            prev = now;
        }
        return { perFrame, carry: em.carry };
    };
    const ref = run();
    for (let r = 0; r < 2; r++) {
        const got = run();
        assert.deepEqual(got.perFrame, ref.perFrame, 'rerun ' + r + ' cadence diverged');
        assert.ok(Object.is(got.carry, ref.carry), 'rerun ' + r + ' final carry diverged');
    }
});

test('S-15 emitter exactness: rate=0 emits nothing over many frames', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    const em = makeEmitter({ x: 400, y: 500, rate: 0, cone: 0.3, speed: 100, life: 100 });
    assert.equal(em.rate, 0);
    for (let f = 0; f < 120; f++) { em.step(e, 1 / 60); e.updateAndDraw(ctx, 1 / 60, 800, 100000); }
    assert.equal(aliveCount(e), 0);
});

test('S-15 emitter exactness: a stopped emitter (constructed but never stepped) leaves the pool to drain to 0', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    const em = makeEmitter({ x: 400, y: 500, rate: 200, cone: 0.5, speed: 100, life: 0.5 });
    em.step(e, 1 / 60); // one step to seed a few live sparks
    e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(aliveCount(e) > 0, 'the seeding step should have spawned something');
    // Now stop stepping the emitter -- only the engine advances. Short life
    // (0.5s) must drain the pool to 0 with no further spawns.
    for (let f = 0; f < 60; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.equal(aliveCount(e), 0, 'the pool did not drain after the emitter stopped stepping');
});

// ===========================================================================
// EMITTER FAIL-CLOSED
// ===========================================================================

test('S-15 emitter fail-closed: construction coerces NaN/Infinity/-5 rate to 0', () => {
    for (const rate of [NaN, Infinity, -Infinity, -5]) {
        const em = makeEmitter({ x: 1, y: 1, rate, cone: 0.5, speed: 100, life: 1 });
        assert.equal(em.rate, 0, 'rate=' + rate);
    }
});

test('S-15 emitter fail-closed: construction coerces NaN speed to 0', () => {
    const em = makeEmitter({ x: 1, y: 1, rate: 10, cone: 0.5, speed: NaN, life: 1 });
    assert.equal(em.speed, 0);
});

test('S-15 emitter fail-closed: construction coerces NaN life to 0', () => {
    const em = makeEmitter({ x: 1, y: 1, rate: 10, cone: 0.5, speed: 100, life: NaN });
    assert.equal(em.life, 0);
});

test('S-15 emitter fail-closed: construction coerces NaN cone to 0', () => {
    const em = makeEmitter({ x: 1, y: 1, rate: 10, cone: NaN, speed: 100, life: 1 });
    assert.equal(em.cone, 0);
});

test('S-15 emitter fail-closed: construction coerces non-finite x/y to 0', () => {
    const em = makeEmitter({ x: NaN, y: Infinity, rate: 10, cone: 0.5, speed: 100, life: 1 });
    assert.equal(em.x, 0);
    assert.equal(em.y, 0);
});

test('S-15 emitter fail-closed: makeEmitter(undefined) / makeEmitter({}) is a fully-inert, finite descriptor', () => {
    for (const opts of [undefined, {}]) {
        const em = makeEmitter(opts);
        assert.equal(em.rate, 0);
        assert.equal(em.speed, 0);
        assert.equal(em.life, 0);
        assert.equal(em.cone, 0);
        assert.equal(em.x, 0);
        assert.equal(em.y, 0);
        assert.equal(em.carry, 0);
        const e = new SparkEngine(16, { rng: () => 0.5 });
        assert.doesNotThrow(() => em.step(e, 1 / 60));
        assert.equal(aliveCount(e), 0);
    }
});

test('S-15 emitter fail-closed: a NaN-dt step never poisons the carry and never spawns', () => {
    const e = new SparkEngine(16, { rng: () => 0.5 });
    const em = makeEmitter({ x: 400, y: 300, rate: 100, cone: 0.5, speed: 100, life: 1 });
    em.step(e, NaN);
    assert.ok(Number.isFinite(em.carry) && em.carry === 0);
    assert.equal(aliveCount(e), 0);
    // The door is not permanently stuck -- a good dt afterwards still works.
    em.step(e, 1 / 60);
    assert.ok(Number.isFinite(em.carry));
});

test('S-15 emitter fail-closed: step() never drives a particle non-finite and never floods the pool under a hostile rate', () => {
    const MAX = 64;
    const e = new SparkEngine(MAX, { rng: () => 0.5 });
    const em = makeEmitter({ x: 400, y: 300, rate: 1e7, cone: 0.6, speed: 500, life: 1.0 });
    for (let f = 0; f < 30; f++) { em.step(e, 1 / 60); e.updateAndDraw(ctx, 1 / 60, 800, 600); }
    assert.ok(aliveCount(e) <= MAX, 'aliveCount ' + aliveCount(e) + ' > max ' + MAX);
    assert.ok(aliveFinite(e), 'a hostile emitter rate drove a live particle non-finite');
});

// ===========================================================================
// ONBOUNCE THRESHOLD EXACTNESS
// ===========================================================================

/**
 * Run a single hand-seeded spark (gravity 0, friction 1, floorFriction 1, so
 * vy is UNCHANGED frame to frame until the exact frame it contacts the floor)
 * toward a floor from far above, for enough frames to guarantee contact, and
 * collect every onBounce call. Because friction/gravity are neutralized, the
 * captured pre-bounce speed (pvy) equals the seeded vy exactly (float32),
 * making the threshold comparison exact rather than approximate.
 */
function runToFloor(threshold, vy, frames = 500) {
    const calls = [];
    const e = new SparkEngine(4, {
        rng: () => 0.5, gravity: 0, friction: 1, floorFriction: 1,
        floorY: 500, onBounceMinSpeed: threshold,
        onBounce: (x, vx, w) => calls.push([x, vx, w]),
    });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 50; e.vx[0] = 20; e.vy[0] = vy;
    e.life[0] = 1000; e.invLife[0] = 0.001; e.weight[0] = 3;
    for (let f = 0; f < frames; f++) e.updateAndDraw(ctx, 1 / 60, 800, 600);
    return calls;
}

test('S-15 onBounce threshold: pre-bounce speed just below onBounceMinSpeed fires 0 times', () => {
    // 99.9 vs threshold 100 -- comfortably outside float32 ULP at this
    // magnitude (~1.2e-5), so the comparison is unambiguous.
    assert.equal(runToFloor(100, 99.9).length, 0);
});

test('S-15 onBounce threshold: pre-bounce speed exactly AT onBounceMinSpeed fires 0 times (strict >)', () => {
    assert.equal(runToFloor(100, 100).length, 0);
});

test('S-15 onBounce threshold: pre-bounce speed just above onBounceMinSpeed fires >= 1 time', () => {
    assert.ok(runToFloor(100, 100.1).length >= 1);
});

test('S-15 onBounce threshold: the callback receives (x, vx, weight) as finite primitives with the expected values', () => {
    const calls = runToFloor(100, 100.1);
    assert.equal(calls.length, 1);
    const [x, vx, weight] = calls[0];
    assert.equal(typeof x, 'number');
    assert.equal(typeof vx, 'number');
    assert.equal(typeof weight, 'number');
    assert.ok(Number.isFinite(x) && Number.isFinite(vx) && Number.isFinite(weight));
    // floorFriction:1 -> vx unchanged from the seeded 20 (>=5, not zeroed).
    assert.equal(vx, 20);
    assert.equal(weight, 3);
    // x is the post-floor-clamp x -- integrated normally, near the floor region.
    assert.ok(x > 400 && x < 500);
});

test('S-15 onBounce threshold: a non-function onBounce is coerced to null at construction (no throw, no fire)', () => {
    for (const bad of [123, 'x', {}, [], true, 0, '']) {
        const e = new SparkEngine(4, { rng: () => 0.5, onBounce: bad });
        assert.equal(e.config.onBounce, null, 'onBounce=' + JSON.stringify(bad));
    }
    // No-throw, and it never fires: run a real bounce scene with a coerced hook.
    const calls = [];
    const badHook = 'not a function';
    const e = new SparkEngine(4, {
        rng: () => 0.5, gravity: 0, friction: 1, floorFriction: 1,
        floorY: 500, onBounce: badHook,
    });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 50; e.vx[0] = 20; e.vy[0] = 300;
    e.life[0] = 1000; e.invLife[0] = 0.001; e.weight[0] = 3;
    assert.doesNotThrow(() => { for (let f = 0; f < 300; f++) e.updateAndDraw(ctx, 1 / 60, 800, 600); });
});

test('S-15 onBounce threshold: onBounce=null (the default) never fires across many bounces', () => {
    const e = new SparkEngine(8, { rng: floatRng(1), gravity: 800, floorY: 500 });
    e.burst(400, 100, 8, 0, Math.PI * 2, 100, 500);
    assert.equal(e.config.onBounce, null);
    assert.doesNotThrow(() => { for (let f = 0; f < 200; f++) e.updateAndDraw(ctx, 1 / 60, 800, 600); });
});

// ===========================================================================
// ONBOUNCE ZERO-EFFECT ON PHYSICS
// ===========================================================================

test('S-15 onBounce zero-effect: a no-op onBounce produces a byte-identical snapshot to onBounce=null', () => {
    const script = (e) => {
        for (let f = 0; f < 90; f++) {
            if ((f % 6) === 0) e.burst(400, 100, 6, 0, Math.PI * 2, 100, 500, 0.4, 1.2);
            e.updateAndDraw(ctx, 1 / 60, 800, 600); // floor is reachable -- real bounces occur
        }
    };
    const off = new SparkEngine(64, { rng: floatRng(0x1337), onBounce: null });
    const noop = new SparkEngine(64, { rng: floatRng(0x1337), onBounce: () => {} });
    script(off); script(noop);
    assert.ok(snapshotsEqual(snapshot(off), snapshot(noop)),
        'a no-op onBounce hook perturbed the simulation or drew extra rng');
});

// ===========================================================================
// SCALE/FADE COERCION PINS (the S4 poison class)
// ===========================================================================

test('S-15 scale/fade coercion: scaleTo=NaN coerces to 1 at construction', () => {
    const e = new SparkEngine(8, { rng: () => 0.5, scaleTo: NaN });
    assert.equal(e.config.scaleTo, 1);
});

test('S-15 scale/fade coercion: scaleTo=NaN renders on the BATCHED lane (globalAlpha untouched, lineWidth stays integer)', () => {
    const e = new SparkEngine(20, { rng: () => 0.5, scaleTo: NaN });
    e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const rec = trackingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.alphaWrites.length, 0, 'the batched lane must never write globalAlpha');
    for (const w of rec.lineWidthWrites) assert.equal(w, Math.trunc(w), 'batched lineWidth ' + w + ' is not an integer bucket 1..4');
});

test('S-15 scale/fade coercion: fadeOut=NaN coerces to 0 at construction', () => {
    const e = new SparkEngine(8, { rng: () => 0.5, fadeOut: NaN });
    assert.equal(e.config.fadeOut, 0);
});

test('S-15 scale/fade coercion: fadeOut=NaN renders on the BATCHED lane (globalAlpha untouched, lineWidth stays integer)', () => {
    const e = new SparkEngine(20, { rng: () => 0.5, fadeOut: NaN });
    e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const rec = trackingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.alphaWrites.length, 0);
    for (const w of rec.lineWidthWrites) assert.equal(w, Math.trunc(w));
});

test('S-15 scale/fade coercion: both NaN together also collapse to the off default and the batched lane runs', () => {
    const e = new SparkEngine(20, { rng: () => 0.5, scaleTo: NaN, fadeOut: NaN });
    assert.equal(e.config.scaleTo, 1);
    assert.equal(e.config.fadeOut, 0);
    e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const rec = trackingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.alphaWrites.length, 0);
});

test('S-15 scale/fade coercion: the default (scaleTo=1, fadeOut=0) renders on the batched lane -- byte-identical to v1.3.1 behavior', () => {
    const e = new SparkEngine(20, { rng: () => 0.5 }); // no scaleTo/fadeOut passed
    e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const rec = trackingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.alphaWrites.length, 0, 'the v1.3.1-equivalent default must never touch globalAlpha');
    assert.ok(rec.lineWidthWrites.length > 0, 'the batched lane must still set an integer lineWidth per bin');
    for (const w of rec.lineWidthWrites) assert.equal(w, Math.trunc(w));
});

test('S-15 scale/fade coercion: a REAL enveloped engine (scaleTo=0.2, fadeOut=0.9) DOES set per-particle globalAlpha and restores it to 1 after the frame', () => {
    const e = new SparkEngine(20, { rng: () => 0.5, scaleTo: 0.2, fadeOut: 0.9 });
    e.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const rec = trackingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.ok(rec.alphaWrites.length > 0, 'the enveloped lane must set per-particle globalAlpha');
    // Every write before the final restore must be a live per-particle alpha
    // in (0,1]; the LAST write must restore exactly to 1 (fail closed).
    assert.equal(rec.alphaWrites[rec.alphaWrites.length - 1], 1, 'globalAlpha not restored to 1 after the frame');
    assert.equal(rec.globalAlpha, 1);
    for (const a of rec.alphaWrites.slice(0, -1)) {
        assert.ok(a > 0 && a <= 1 && Number.isFinite(a), 'per-particle alpha ' + a + ' out of (0,1]');
    }
});

test('adversarial: scaleTo=-0 flips the enveloped lane ON, but fadeOut=-0 alone does NOT -- the two `!==` sentinels (1 vs 0) treat -0 asymmetrically', () => {
    // `enveloped = scaleTo !== 1 || fadeOut !== 0`. Per IEEE754/JS semantics,
    // `-0 !== 1` is true (scaleTo=-0 is not the number 1) but `-0 !== 0` is
    // false (`!==` uses the strict-equality algorithm, under which -0 === 0).
    // So a caller who hands scaleTo=-0 unknowingly opts INTO the per-particle
    // stroke lane, while fadeOut=-0 alone stays on the cheap batched lane.
    // Neither poisons anything (both coerce-through Number.isFinite(-0)===true),
    // but the asymmetry is a real, non-obvious boundary the S5 planner's
    // ASSERTIONS list did not enumerate.
    const scaleNeg0 = new SparkEngine(20, { rng: () => 0.5, scaleTo: -0 });
    assert.ok(Object.is(scaleNeg0.config.scaleTo, -0), 'scaleTo=-0 must survive the NaN-only coercion unchanged');
    scaleNeg0.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const recA = trackingCtx();
    scaleNeg0.updateAndDraw(recA, 1 / 60, 800, 600);
    assert.ok(recA.alphaWrites.length > 0, 'scaleTo=-0 was expected to select the ENVELOPED lane (globalAlpha touched)');
    assert.ok(aliveFinite(scaleNeg0), 'scaleTo=-0 must not poison any particle');

    const fadeNeg0 = new SparkEngine(20, { rng: () => 0.5, fadeOut: -0 });
    assert.ok(Object.is(fadeNeg0.config.fadeOut, -0));
    fadeNeg0.burst(400, 300, 10, 0, Math.PI * 2, 100, 500);
    const recB = trackingCtx();
    fadeNeg0.updateAndDraw(recB, 1 / 60, 800, 600);
    assert.equal(recB.alphaWrites.length, 0, 'fadeOut=-0 alone was expected to stay on the BATCHED lane');
    assert.ok(aliveFinite(fadeNeg0));
});

// ===========================================================================
// DISPOSE LIFECYCLE / RE-ENTRANCY -- new S-15 entry points
// ===========================================================================

test('boundary: duplicate dispose on an engine configured with onBounce/scaleTo/fadeOut does not throw', () => {
    const e = new SparkEngine(16, { rng: () => 0.5, onBounce: () => {}, scaleTo: 0.3, fadeOut: 0.5 });
    burstPreset(e, 400, 300, SPARK_PRESETS.weld);
    e.destroy();
    assert.doesNotThrow(() => e.destroy());
    assert.doesNotThrow(() => e.destroy());
    assert.equal(e.x, null);
});

test('boundary: dispose-during-iteration -- an onBounce hook that calls engine.destroy() mid-frame does not throw', () => {
    let e;
    e = new SparkEngine(8, {
        rng: () => 0.5, gravity: 0, friction: 1, floorY: 500,
        onBounce: () => { e.destroy(); },
    });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 490; e.vx[0] = 0; e.vy[0] = 2000;
    e.life[0] = 100; e.invLife[0] = 0.01; e.weight[0] = 2;
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 1 / 60, 800, 600));
    assert.equal(e.x, null, 'destroy() from inside onBounce should still take effect');
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 1 / 60, 800, 600)); // post-destroy call is a silent no-op
});

test('boundary: re-entrant write -- an onBounce hook that calls engine.burst() mid-frame spawns live sparks without throwing', () => {
    let e2;
    e2 = new SparkEngine(8, {
        rng: () => 0.5, gravity: 0, friction: 1, floorY: 500,
        onBounce: () => { e2.burst(1, 1, 2, 0, Math.PI * 2, 10, 20); },
    });
    e2.state[0] = 1; e2.x[0] = 400; e2.y[0] = 490; e2.vx[0] = 0; e2.vy[0] = 2000;
    e2.life[0] = 100; e2.invLife[0] = 0.01; e2.weight[0] = 2;
    assert.doesNotThrow(() => e2.updateAndDraw(ctx, 1 / 60, 800, 600));
    assert.ok(aliveCount(e2) >= 3, 'expected the original spark plus 2 re-entrant sparks alive');
});

test('boundary: makeEmitter.step() on a destroyed engine is a silent no-op, not a throw', () => {
    const e = new SparkEngine(8, { rng: () => 0.5 });
    e.destroy();
    const em = makeEmitter({ x: 1, y: 1, rate: 100, cone: 0.5, speed: 100, life: 1 });
    assert.doesNotThrow(() => em.step(e, 1 / 60));
    assert.equal(e.x, null); // step() did not resurrect the destroyed engine
});

test('boundary: burstPreset() on a destroyed engine is a silent no-op, not a throw', () => {
    const e = new SparkEngine(8, { rng: () => 0.5 });
    e.destroy();
    assert.doesNotThrow(() => burstPreset(e, 400, 300, SPARK_PRESETS.impact));
    assert.equal(e.x, null);
});
