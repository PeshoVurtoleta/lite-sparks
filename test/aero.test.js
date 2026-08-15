/**
 * @zakkster/lite-sparks -- S-13 air forces (v1.3.0) boundary suite.
 *
 * The aero wave adds four cold config keys (wind / gust / turbulence / drag), a
 * cold engine clock (_elapsed), and exactly ONE hoisted `if (aero)` in the
 * moving block. These are the unit-level companions to the torture-tier T0/T6/T9
 * versions of the same laws, at a size node:test runs in milliseconds:
 *
 *   - defaults + drag alias (cold-path contract; null is not zero)
 *   - aero-off is byte-identical to v1.2.0 (aero gate false -> body unchanged)
 *   - wind direction + magnitude, gust zero-mean, turbulence per-spark divergence
 *   - the S-05 sleep interaction: air never wakes a resting ember (ADR 0008)
 *   - NaN knobs: config numerics are TRUSTED -- a NaN knob poisons a live moving
 *     spark exactly as a NaN gravity would; the sleep guard still shields resters
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkEngine } from '../SparkEngine.js';

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

/** Seed one hand-placed free-flight spark into slot 0 (tall canvas, no floor). */
function seedSpark(e, { vx = 0, vy = -100, life = 100 } = {}) {
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 500; e.vx[0] = vx; e.vy[0] = vy;
    e.life[0] = life; e.invLife[0] = 1 / life; e.weight[0] = 2;
}

// ---------------------------------------------------------------------------
// Defaults + drag alias (cold path).
// ---------------------------------------------------------------------------

test('S-13: air knobs default to off (wind/gust/turbulence 0, drag null)', () => {
    const e = new SparkEngine(8, { rng: () => 0.5 });
    assert.equal(e.config.wind, 0);
    assert.equal(e.config.gust, 0);
    assert.equal(e.config.turbulence, 0);
    assert.equal(e.config.drag, null);
    assert.equal(e._elapsed, 0);
});

test('S-13: drag != null OVERRIDES friction (alias only, no new hot knob)', () => {
    const e = new SparkEngine(8, { rng: () => 0.5, drag: 0.5 });
    assert.equal(e.config.friction, 0.5); // drag became the friction base
});

test('S-13: drag null leaves the friction default untouched (0.99)', () => {
    const e = new SparkEngine(8, { rng: () => 0.5 });
    assert.equal(e.config.friction, 0.99);
});

test('S-13: drag 0 is HONORED (friction := 0, total drag) -- null is not zero', () => {
    const e = new SparkEngine(8, { rng: () => 0.5, drag: 0 });
    assert.equal(e.config.friction, 0); // 0 is a meaningful value, not "unset"
});

test('S-13: passing both drag and friction -- drag wins (applied after the spread)', () => {
    const e = new SparkEngine(8, { rng: () => 0.5, friction: 0.9, drag: 0.5 });
    assert.equal(e.config.friction, 0.5);
});

// ---------------------------------------------------------------------------
// Aero-off is byte-identical to v1.2.0.
// ---------------------------------------------------------------------------

test('S-13: aero-off is byte-identical to the default (v1.2.0) path over a seeded run', () => {
    const max = 96;
    const a = new SparkEngine(max, { rng: floatRng(777) });                               // default
    const b = new SparkEngine(max, { rng: floatRng(777), wind: 0, gust: 0, turbulence: 0 }); // explicit off
    for (let f = 0; f < 60; f++) {
        if (f % 5 === 0) {
            a.burst(400, 300, 8, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
            b.burst(400, 300, 8, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
        }
        a.updateAndDraw(ctx, 1 / 60, 800, 600);
        b.updateAndDraw(ctx, 1 / 60, 800, 600);
    }
    for (let i = 0; i < max; i++) {
        assert.equal(a.state[i], b.state[i], 'state[' + i + '] diverged');
        assert.ok(Object.is(a.x[i], b.x[i]) && Object.is(a.y[i], b.y[i]), 'pos[' + i + '] diverged');
        assert.ok(Object.is(a.vx[i], b.vx[i]) && Object.is(a.vy[i], b.vy[i]), 'vel[' + i + '] diverged');
        assert.ok(Object.is(a.life[i], b.life[i]), 'life[' + i + '] diverged');
    }
});

// ---------------------------------------------------------------------------
// Wind: direction + magnitude.
// ---------------------------------------------------------------------------

test('S-13: wind=300 over 60 frames @ dt=1/60 advances x by >= +145px vs wind=0', () => {
    // friction 1 isolates the wind push from air drag; tall canvas -> free flight.
    const runX = (w) => {
        const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, wind: w });
        seedSpark(e);
        for (let f = 0; f < 60; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
        return e.x[0];
    };
    const dx = runX(300) - runX(0);
    assert.ok(dx >= 145, 'wind advanced x by ' + dx.toFixed(2) + 'px, want >= 145');
});

test('S-13: negative wind pushes -x (direction witness)', () => {
    const runX = (w) => {
        const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, wind: w });
        seedSpark(e);
        for (let f = 0; f < 60; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
        return e.x[0];
    };
    assert.ok(runX(-300) < runX(0) - 145, 'negative wind did not push -x enough');
});

// ---------------------------------------------------------------------------
// Gust: zero-mean oscillation over one full period.
// ---------------------------------------------------------------------------

test('S-13: gust=300 over one full period (GUST_HZ=TAU/3) is zero-mean (|mean| <= 1e-6*300)', () => {
    const G = 300, dt = 1 / 60, PERIOD = 180; // 3s period / (1/60s) = 180 frames
    // gravity 0, friction 1, wind 0 -> vx == dt * sum(gustNow), so the field's
    // mean over the period is vx / (PERIOD*dt).
    const e = new SparkEngine(4, { rng: () => 0.5, gravity: 0, friction: 1, gust: G });
    seedSpark(e, { vx: 0, vy: 1e-3 }); // tiny vy so the spark is not asleep
    for (let f = 0; f < PERIOD; f++) e.updateAndDraw(ctx, dt, 800, 100000);
    const meanField = e.vx[0] / (PERIOD * dt);
    assert.ok(Math.abs(meanField) <= 1e-6 * G,
        'gust field mean over one period = ' + Math.abs(meanField) + ', want <= ' + (1e-6 * G));
});

// ---------------------------------------------------------------------------
// Turbulence: per-spark divergence + determinism.
// ---------------------------------------------------------------------------

test('S-13: turbulence=400 -- two distinct-invLife sparks diverge > 0.5px by frame 30', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, gravity: 0, friction: 1, turbulence: 400 });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 500; e.vx[0] = 0; e.vy[0] = 1e-3;
    e.life[0] = 0.5; e.invLife[0] = 1 / 0.5; e.weight[0] = 2; // invLife 2
    e.state[1] = 1; e.x[1] = 400; e.y[1] = 500; e.vx[1] = 0; e.vy[1] = 1e-3;
    e.life[1] = 1.0; e.invLife[1] = 1 / 1.0; e.weight[1] = 2; // invLife 1
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    const sep = Math.hypot(e.x[0] - e.x[1], e.y[0] - e.y[1]);
    assert.ok(sep > 0.5, 'turbulence separation ' + sep.toFixed(3) + 'px, want > 0.5');
});

test('S-13: turbulence is deterministic -- 3 reruns are bit-identical', () => {
    const run = () => {
        const e = new SparkEngine(4, { rng: () => 0.5, gravity: 0, friction: 1, turbulence: 400 });
        seedSpark(e, { vy: 1e-3, life: 0.7 });
        for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
        return [e.x[0], e.y[0], e.vx[0], e.vy[0]];
    };
    const a = run(), b = run(), c = run();
    for (let k = 0; k < a.length; k++) {
        assert.ok(Object.is(a[k], b[k]) && Object.is(a[k], c[k]),
            'turbulence rerun diverged at channel ' + k);
    }
});

// ---------------------------------------------------------------------------
// Sleep interaction: air never wakes a resting ember (ADR 0008 REJECTED case).
// ---------------------------------------------------------------------------

test('S-13: a resting spark (vx==vy==0) is NOT moved by wind/gust/turbulence (aero is inside the moving block)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, wind: 300, gust: 300, turbulence: 400 });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0; // asleep
    e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 600);
    assert.equal(e.vx[0], 0);      // never accelerated
    assert.equal(e.vy[0], 0);      // still asleep
    assert.equal(e.x[0], 400);     // never moved
});

test('S-13: a MOVING spark under the same air is pushed (proves the resting test is not vacuous)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, wind: 300 });
    seedSpark(e, { vx: 0, vy: -100 }); // moving (vy != 0)
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(e.x[0] > 400, 'a moving spark should be pushed +x by wind');
});

// ---------------------------------------------------------------------------
// Non-finite knobs FAIL CLOSED: coerced to off in the cold constructor, never
// reach the hot loop, never re-open the S-01 whole-pool poison class.
// ---------------------------------------------------------------------------

/** True iff every live particle's x/y/vx/vy/life is finite (the S-01 detector). */
function aliveFinite(e) {
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 1) continue;
        if (!(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]) &&
              Number.isFinite(e.vx[i]) && Number.isFinite(e.vy[i]) &&
              Number.isFinite(e.life[i]))) return false;
    }
    return true;
}

test('S-13: a non-finite wind/gust/turbulence is coerced to 0 in the constructor (fail closed)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        assert.equal(new SparkEngine(4, { rng: () => 0.5, wind: bad }).config.wind, 0);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, gust: bad }).config.gust, 0);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, turbulence: bad }).config.turbulence, 0);
    }
});

test('S-13: a NaN air knob is a NO-OP on a LIVE MOVING spark -- it stays finite (S-01 stays closed)', () => {
    // The fail-closed coercion turns a non-finite knob into "off", so aero is
    // false and the moving spark advances exactly as with the knob absent. A
    // NaN knob must NEVER poison the pool the way a NaN dt used to (S-01).
    for (const cfg of [{ wind: NaN }, { gust: NaN }, { turbulence: NaN }, { wind: Infinity }]) {
        const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, ...cfg });
        seedSpark(e, { vy: -100 }); // moving -> would feel aero if the knob leaked
        assert.doesNotThrow(() => e.updateAndDraw(ctx, 1 / 60, 800, 100000));
        assert.ok(Number.isFinite(e.vx[0]) && Number.isFinite(e.vy[0]),
            'NaN knob poisoned a moving spark under ' + JSON.stringify(cfg));
        assert.ok(aliveFinite(e), 'aliveFinite must hold after a NaN knob under ' + JSON.stringify(cfg));
    }
});

test('S-13: a non-finite drag is IGNORED -- friction keeps its value, pow() never sees NaN (aero-off pool stays finite)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        const e = new SparkEngine(4, { rng: () => 0.5, friction: 0.9, drag: bad });
        assert.equal(e.config.friction, 0.9); // bad drag did not clobber friction
        seedSpark(e, { vy: -100 });
        assert.doesNotThrow(() => e.updateAndDraw(ctx, 1 / 60, 800, 100000));
        assert.ok(aliveFinite(e), 'non-finite drag=' + bad + ' NaNed the pool through pow()');
    }
});

test('S-13: a NaN air knob leaves a RESTING spark finite too (belt and braces)', () => {
    for (const cfg of [{ wind: NaN }, { gust: NaN }, { turbulence: NaN }]) {
        const e = new SparkEngine(4, { rng: () => 0.5, ...cfg });
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0; // asleep
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
        e.updateAndDraw(ctx, 1 / 60, 800, 600);
        assert.ok(aliveFinite(e), 'resting spark went non-finite under ' + JSON.stringify(cfg));
    }
});
