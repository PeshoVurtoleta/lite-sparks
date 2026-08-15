/**
 * @zakkster/lite-sparks -- QA boundary coverage.
 *
 * S1 (v1.0.2) FLIPPED the S-01/S-02 anchors from the v1.0.1 buggy behavior to
 * the fixed behavior now that the hostile-input doors are closed:
 *   - S-01: a non-finite `dt` is a no-op frame -- live particles stay finite.
 *   - S-02: `burst(0|NaN|-5|null|undefined|-0)` spawns 0; `1.5` spawns 1; a valid
 *     count spawns `min(count, freeSlots)`.
 * S2 (v1.1.0) FLIPPED the S-05 anchor from the v1.0.1 mid-air-hang behavior to
 * the fixed behavior: a zero-speed burst now seeds a `1e-3` vy at spawn so
 * gravity engages and the spark falls to the floor. Do not "fix" an assertion
 * here without a corresponding SparkEngine.js change landing in the same session.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SparkEngine, VERSION } from '../SparkEngine.js';

// Same lightweight ctx stub as test/SparkEngine.test.js.
const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

function aliveCount(e, max) {
    let n = 0;
    for (let i = 0; i < max; i++) if (e.state[i] === 1) n++;
    return n;
}

// ---------------------------------------------------------------------------
// S0: version sync invariant (not a pinned bug anchor -- infra requirement).
// ---------------------------------------------------------------------------

test('S0: VERSION export exists and matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    assert.equal(typeof VERSION, 'string');
    assert.equal(VERSION, pkg.version);
});

// ---------------------------------------------------------------------------
// S-0x anchors required by the S0 brief.
// ---------------------------------------------------------------------------

test('S-02: fixed v1.0.2 -- burst(x,y,0,...) spawns 0 (count door)', () => {
    const e = new SparkEngine(50, { rng: () => 0.5 });
    e.burst(400, 300, 0, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 50), 0);
});

test('S-02: fixed v1.0.2 -- burst(x,y,NaN,...) spawns 0 (no full-pool fill)', () => {
    const e = new SparkEngine(30, { rng: () => 0.5 });
    e.burst(400, 300, NaN, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 30), 0);
});

test('S-02: fixed v1.0.2 -- burst(x,y,-5,...) spawns 0 (count door)', () => {
    const e = new SparkEngine(30, { rng: () => 0.5 });
    e.burst(400, 300, -5, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 30), 0);
});

test('S-02: fixed v1.0.2 -- burst(x,y,1.5,...) floors to spawn exactly 1', () => {
    const e = new SparkEngine(30, { rng: () => 0.5 });
    e.burst(400, 300, 1.5, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 30), 1);
});

test('S-01: fixed v1.0.2 -- updateAndDraw(ctx, NaN, w, h) is a no-op, leaves particles finite', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 300, 1, 0, Math.PI * 2, 100, 500);
    const xBefore = e.x[0];
    const lifeBefore = e.life[0];
    e.updateAndDraw(ctx, NaN, 800, 600);
    assert.ok(Number.isFinite(e.x[0]));    // door rejected NaN -> no poison
    assert.ok(Number.isFinite(e.life[0]));
    assert.equal(e.x[0], xBefore);         // no-op: last good state untouched
    assert.equal(e.life[0], lifeBefore);
    assert.equal(e.state[0], 1);           // still alive
});

test('S-01: fixed v1.0.2 -- updateAndDraw(ctx, -1|Infinity|0, w, h) leaves every live particle finite', () => {
    for (const dt of [-1, Infinity, 0, -Infinity, -0]) {
        const e = new SparkEngine(10, { rng: () => 0.5 });
        e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
        e.updateAndDraw(ctx, dt, 800, 600);
        for (let i = 0; i < 10; i++) {
            if (e.state[i] !== 1) continue;
            assert.ok(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]) &&
                Number.isFinite(e.vx[i]) && Number.isFinite(e.vy[i]) &&
                Number.isFinite(e.life[i]), 'dt=' + dt + ' poisoned slot ' + i);
        }
    }
});

test('S-11: fixed v1.0.2 -- burst(...,lifeMin=0,lifeMax=0) never yields Infinity invLife or NaN colorIdx', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 300, 3, 0, Math.PI * 2, 100, 500, 0, 0); // lifeMin=lifeMax=0
    for (let i = 0; i < 10; i++) {
        if (e.state[i] !== 1) continue;
        assert.ok(Number.isFinite(e.invLife[i]), 'invLife not finite at ' + i);
        assert.ok(e.life[i] > 0, 'life not clamped above 0 at ' + i);
        const colorIdx = Math.floor((e.life[i] * e.invLife[i]) * e.colors.length);
        assert.ok(Number.isFinite(colorIdx), 'colorIdx NaN at ' + i);
    }
});

test('S-05: fixed v1.1.0 -- zero-speed burst falls under gravity and lands on the floor', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 100, 1, 0, 0, 0, 0, 5, 5); // speedMin=speedMax=0 -> vx=vy=0; S-05 seeds vy=1e-3
    const yBefore = e.y[0];
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 0.1, 800, 600);
    assert.ok(e.y[0] > yBefore);   // gravity engaged -- the spark fell, no mid-air hang
    const floorY = 600 - e.weight[0] / 2;
    assert.ok(Math.abs(e.y[0] - floorY) < 1); // landed on the floor
    assert.equal(e.state[0], 1);   // still alive (life=5, 30*0.1=3.0 consumed)
});

// ---------------------------------------------------------------------------
// Boundary matrix -- burst(count) against a fixed pool of N=10.
// ---------------------------------------------------------------------------

const N = 10;

test('boundary: burst count=1 spawns exactly 1', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, 1, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), 1);
});

test('boundary: burst count=N-1 spawns exactly N-1', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, N - 1, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), N - 1);
});

test('boundary: burst count=N fills the pool exactly', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, N, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), N);
});

test('boundary: burst count=N+1 clamps to N (min(count, freeSlots))', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, N + 1, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), N);
});

test('boundary: burst into an already-full (empty free-slot) pool spawns nothing more', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, N, 0, Math.PI * 2, 100, 500); // fill it
    e.burst(400, 300, 1, 0, Math.PI * 2, 100, 500);  // no free slots left
    assert.equal(aliveCount(e, N), N);
});

test('boundary: fixed v1.0.2 -- burst count=null spawns 0 (null >= 1 is false)', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, null, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), 0); // `null >= 1` -> false -> count=0 -> return
});

test('boundary: fixed v1.0.2 -- burst count=undefined spawns 0 (NaN >= 1 is false)', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, undefined, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), 0); // `undefined >= 1` -> `NaN >= 1` -> false
});

test('boundary: fixed v1.0.2 -- burst count=-0 spawns 0 (-0 >= 1 is false)', () => {
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, -0, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, N), 0); // `-0 >= 1` -> false
});

// ---------------------------------------------------------------------------
// Dispose lifecycle.
// ---------------------------------------------------------------------------

test('boundary: duplicate dispose does not throw and leaves arrays null', () => {
    const e = new SparkEngine(N);
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    e.destroy();
    assert.doesNotThrow(() => e.destroy());
    assert.doesNotThrow(() => e.destroy()); // a third time for good measure
    assert.equal(e.x, null);
    assert.equal(e.state, null);
});

test('boundary: calls after dispose are silent no-ops, not throws', () => {
    const e = new SparkEngine(N);
    e.destroy();
    assert.doesNotThrow(() => e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500));
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
    assert.doesNotThrow(() => e.clear());
    assert.equal(e.x, null); // burst() after destroy did not resurrect arrays
});

test('boundary: pinned v1.0.1 behavior -- dispose-during-iteration throws TypeError on the next slot', () => {
    // Re-entrant destroy() from inside a per-particle callback nulls every SoA
    // column mid-loop; the very next array read in the same updateAndDraw pass
    // throws because `this.life` etc. are now `null`. This is NOT caught by the
    // engine -- current v1.0.1 has no re-entrancy guard.
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    let strokeCalls = 0;
    const disposingCtx = {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() { strokeCalls++; if (strokeCalls === 1) e.destroy(); },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    assert.throws(
        () => e.updateAndDraw(disposingCtx, 0.016, 800, 600),
        TypeError
    );
    assert.equal(strokeCalls, 1);
    assert.equal(e.x, null);
});

// ---------------------------------------------------------------------------
// Re-entrant write.
// ---------------------------------------------------------------------------

test('boundary: pinned v1.0.1 behavior -- re-entrant burst() during updateAndDraw is processed same frame', () => {
    // burst() called from inside the ctx callback writes new live particles into
    // slots the in-flight `for` loop has not reached yet, so they get physics +
    // a draw call in the SAME updateAndDraw pass they were spawned in (no
    // re-entrancy guard exists in v1.0.1).
    const e = new SparkEngine(N, { rng: () => 0.5 });
    e.burst(400, 300, 3, 0, Math.PI * 2, 100, 500);
    let strokeCalls = 0;
    const reentrantCtx = {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {
            strokeCalls++;
            if (strokeCalls === 1) e.burst(500, 500, 5, 0, Math.PI * 2, 100, 500);
        },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    assert.doesNotThrow(() => e.updateAndDraw(reentrantCtx, 0.016, 800, 600));
    assert.equal(aliveCount(e, N), 8);   // 3 original + 5 re-entrant
    assert.equal(strokeCalls, 8);        // the 5 new particles were drawn this frame too
});

// ---------------------------------------------------------------------------
// Adversarial cases the S0 planner did not enumerate.
// ---------------------------------------------------------------------------

test('adversarial: negative maxParticles throws RangeError at construction (native TypedArray bound)', () => {
    // Not caught or validated by the engine -- it fails closed only because
    // `new Float32Array(-1)` itself throws. No SparkEngine-level guard exists.
    assert.throws(() => new SparkEngine(-1), RangeError);
});

test('adversarial: maxParticles=0 is a safe no-op pool across burst and updateAndDraw', () => {
    const e = new SparkEngine(0, { rng: () => 0.5 });
    assert.equal(e.x.length, 0);
    assert.doesNotThrow(() => e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500));
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
    assert.equal(aliveCount(e, 0), 0);
});

// ---------------------------------------------------------------------------
// QA-added boundary coverage (S1 v1.0.2) -- unit-level companions to the
// torture-tier T0/T1 versions of the same laws, at a size node:test can run
// in milliseconds rather than the 10k-frame torture scale.
// ---------------------------------------------------------------------------

test('S1: fixed behavior -- S-01 quarantine at unit level: N good frames + one NaN-dt frame + N good frames matches a never-poisoned control', () => {
    const M = 32;
    const GOOD_FRAMES = 200;

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

    const control = new SparkEngine(M, { rng: floatRng(777) });
    const poisoned = new SparkEngine(M, { rng: floatRng(777) });

    const goodFrame = (e, f) => {
        if (f % 5 === 0) e.burst(400, 100, 4, 0, Math.PI * 2, 50, 300, 0.2, 0.8);
        e.updateAndDraw(ctx, 1 / 60, 800, 600);
    };

    for (let f = 0; f < GOOD_FRAMES; f++) { goodFrame(control, f); goodFrame(poisoned, f); }

    // One poison-dt frame on `poisoned` only -- the door must make it a no-op.
    poisoned.updateAndDraw(ctx, NaN, 800, 600);
    for (let i = 0; i < M; i++) {
        if (poisoned.state[i] !== 1) continue;
        assert.ok(
            Number.isFinite(poisoned.x[i]) && Number.isFinite(poisoned.y[i]) &&
            Number.isFinite(poisoned.vx[i]) && Number.isFinite(poisoned.vy[i]) &&
            Number.isFinite(poisoned.life[i]),
            'slot ' + i + ' went non-finite after the poison frame'
        );
    }

    for (let f = GOOD_FRAMES; f < 2 * GOOD_FRAMES; f++) { goodFrame(control, f); goodFrame(poisoned, f); }

    assert.equal(aliveCount(poisoned, M), aliveCount(control, M));
    for (let i = 0; i < M; i++) {
        assert.equal(poisoned.state[i], control.state[i], 'state[' + i + '] diverged from control');
        if (poisoned.state[i] !== 1) continue;
        assert.equal(poisoned.x[i], control.x[i], 'x[' + i + '] diverged from control');
        assert.equal(poisoned.y[i], control.y[i], 'y[' + i + '] diverged from control');
        assert.equal(poisoned.vx[i], control.vx[i], 'vx[' + i + '] diverged from control');
        assert.equal(poisoned.vy[i], control.vy[i], 'vy[' + i + '] diverged from control');
        assert.equal(poisoned.life[i], control.life[i], 'life[' + i + '] diverged from control');
    }
});

test('S1: fixed behavior -- burst into a pool with exactly 1 free slot, count=5, spawns exactly 1 (exhausted-pool boundary)', () => {
    const M = 6;
    const e = new SparkEngine(M, { rng: () => 0.5 });
    e.burst(400, 300, M - 1, 0, Math.PI * 2, 100, 500); // fill all but 1 slot
    assert.equal(aliveCount(e, M), M - 1);
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500); // ask for 5 into 1 free slot
    assert.equal(aliveCount(e, M), M); // exactly 1 more spawned -> pool now full, not overfull
});

test('S1: fixed behavior -- negative dt (-0.016) is a no-op, does not run physics backward', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    const snapshot = {
        x: Array.from(e.x), y: Array.from(e.y), vx: Array.from(e.vx),
        vy: Array.from(e.vy), life: Array.from(e.life), state: Array.from(e.state),
    };
    e.updateAndDraw(ctx, -0.016, 800, 600);
    for (let i = 0; i < 10; i++) {
        assert.equal(e.state[i], snapshot.state[i], 'state[' + i + '] mutated by negative dt');
        assert.equal(e.x[i], snapshot.x[i], 'x[' + i + '] mutated by negative dt');
        assert.equal(e.y[i], snapshot.y[i], 'y[' + i + '] mutated by negative dt');
        assert.equal(e.vx[i], snapshot.vx[i], 'vx[' + i + '] mutated by negative dt');
        assert.equal(e.vy[i], snapshot.vy[i], 'vy[' + i + '] mutated by negative dt');
        assert.equal(e.life[i], snapshot.life[i], 'life[' + i + '] mutated by negative dt');
    }
});

// ---------------------------------------------------------------------------
// QA-added S2 (v1.1.0) ASSERTION pins -- independent verification, unit-level.
// These are QA companions to the torture-tier T0/T9 versions of the same laws
// (test/torture/t0-laws.mjs, t9-controls.mjs), written from the ROADMAP S2
// ASSERTIONS list directly rather than copied from the coder's own tests.
// ---------------------------------------------------------------------------

/** A ctx stub that records clearRect and stroke call counts. */
function recordingCtx() {
    const c = {
        clears: 0, strokes: 0,
        clearRect() { c.clears++; }, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() { c.strokes++; },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    return c;
}

// --- Assertion 1: autoClear:false leaves prior pixels (S-03) ---------------

test('S-03: default engine (autoClear:true) calls clearRect exactly once per updateAndDraw', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    const rec = recordingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.clears, 1);
    assert.equal(rec.strokes, 5); // sanity: it also drew the live sparks
});

test('S-03: autoClear:false calls clearRect ZERO times while still stroking live sparks', () => {
    const e = new SparkEngine(10, { rng: () => 0.5, autoClear: false });
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    const rec = recordingCtx();
    e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.clears, 0);      // never wipes the caller's prior pixels
    assert.equal(rec.strokes, 5);     // but live sparks are still drawn over them
});

test('S-03: autoClear:false over multiple frames never clears, each frame still strokes', () => {
    const e = new SparkEngine(10, { rng: () => 0.5, autoClear: false });
    e.burst(400, 300, 3, 0, Math.PI * 2, 100, 500);
    const rec = recordingCtx();
    for (let f = 0; f < 5; f++) e.updateAndDraw(rec, 1 / 60, 800, 600);
    assert.equal(rec.clears, 0);
    assert.ok(rec.strokes > 0);
});

// --- Assertion 2: dt-scaling law (T0) + concrete regression number ---------

test('S-04: dt-scaling law -- one dt step vs two dt/2 steps land within tolerance (free flight, no bounce)', () => {
    const DT = 1 / 30;
    const POS_TOL = 1.0; // px
    const VEL_TOL = 1.0; // px/s
    const W = 800, H = 100000; // tall enough the floor is never reached

    const seed = (e) => {
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 500;
        e.vx[0] = 200; e.vy[0] = -100;
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
    };

    const big = new SparkEngine(4, { rng: () => 0.5 });
    const half = new SparkEngine(4, { rng: () => 0.5 });
    seed(big); seed(half);

    big.updateAndDraw(ctx, DT, W, H);
    half.updateAndDraw(ctx, DT / 2, W, H);
    half.updateAndDraw(ctx, DT / 2, W, H);

    assert.ok(Math.abs(big.x[0] - half.x[0]) < POS_TOL, 'x diverged ' + Math.abs(big.x[0] - half.x[0]));
    assert.ok(Math.abs(big.y[0] - half.y[0]) < POS_TOL, 'y diverged ' + Math.abs(big.y[0] - half.y[0]));
    assert.ok(Math.abs(big.vx[0] - half.vx[0]) < VEL_TOL, 'vx diverged ' + Math.abs(big.vx[0] - half.vx[0]));
    assert.ok(Math.abs(big.vy[0] - half.vy[0]) < VEL_TOL, 'vy diverged ' + Math.abs(big.vy[0] - half.vy[0]));
});

test('S-04: 30fps-vs-120fps concrete regression -- new engine divergence < 1px; old *=friction/frame model diverges ~28px', () => {
    // Matches the ROADMAP/decision-0004 methodology exactly: gravity 0, one
    // particle, vx0=100, 1 second of wall-clock at 30fps vs 120fps.
    const W = 800, H = 100000;
    const GRAV = 0, FRICTION = 0.99, VX0 = 100;

    const seed = (e) => {
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 500;
        e.vx[0] = VX0; e.vy[0] = 0;
        e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;
    };

    // --- new (fixed) engine: pow(friction, dt*60) ---
    const e30 = new SparkEngine(4, { rng: () => 0.5, gravity: GRAV, friction: FRICTION });
    seed(e30);
    for (let i = 0; i < 30; i++) e30.updateAndDraw(ctx, 1 / 30, W, H);

    const e120 = new SparkEngine(4, { rng: () => 0.5, gravity: GRAV, friction: FRICTION });
    seed(e120);
    for (let i = 0; i < 120; i++) e120.updateAndDraw(ctx, 1 / 120, W, H);

    const newDivergence = Math.abs(e30.x[0] - e120.x[0]);
    assert.ok(newDivergence < 1, 'new-model 30-vs-120fps divergence ' + newDivergence + ' >= 1px');

    // --- old (pre-S-04) reference model: bare `v *= friction` per frame,
    // independent of dt. Kept inline -- this is NOT imported from SparkEngine.js.
    function oldModelXAfterOneSecond(fps, vx0) {
        const dt = 1 / fps, n = fps;
        let vx = vx0, x = 0;
        for (let i = 0; i < n; i++) {
            vx *= FRICTION;
            x += vx * dt;
        }
        return x;
    }
    const oldX30 = oldModelXAfterOneSecond(30, VX0);
    const oldX120 = oldModelXAfterOneSecond(120, VX0);
    const oldDivergence = Math.abs(oldX30 - oldX120);

    // Documented ~28px (ROADMAP line 97, decisions/0004-dt-friction.md line 20).
    assert.ok(oldDivergence > 25 && oldDivergence < 31,
        'old-model divergence ' + oldDivergence + ' not close to the documented ~28px');
    assert.ok(oldDivergence > newDivergence * 10,
        'old-model divergence (' + oldDivergence + ') should dwarf the fixed engine (' + newDivergence + ')');
});

// --- Assertion 3: 60fps byte-identity to the pre-S-04 calibration anchor ---

test('S-04: 60fps output is byte-identical (===) to the pre-S-04 model, over 600 frames, free flight', () => {
    // The engine's SoA columns are Float32Array, so the reference trajectory
    // must also be computed and STORED at float32 precision at every step for
    // a "byte-identical" (===) comparison to be meaningful -- comparing against
    // a float64 reference fails from frame 0 on rounding alone, not on any
    // physics divergence. This Float32Array-backed reference is the literal
    // pre-S-04 model: `vx *= 0.99; vy *= 0.99` per frame, plus the same
    // gravity + move, at 60fps where dt*60===1 exactly (verified inline below).
    const dt = 1 / 60;
    assert.equal(dt * 60, 1); // the calibration anchor's load-bearing fact
    assert.equal(Math.pow(0.99, dt * 60), 0.99); // pow(x,1) === x exactly

    const W = 800, H = 1e9; // never reaches the floor
    const GRAV = 800, FRICTION = 0.99;

    const e = new SparkEngine(4, { rng: () => 0.5, gravity: GRAV, friction: FRICTION });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 500; e.vx[0] = 200; e.vy[0] = -300;
    e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;

    // ref[0..3] = x,y,vx,vy -- Float32Array so every write rounds exactly like
    // the engine's own SoA columns.
    const ref = new Float32Array(4);
    ref[0] = 400; ref[1] = 500; ref[2] = 200; ref[3] = -300;

    for (let f = 0; f < 600; f++) {
        e.updateAndDraw(ctx, dt, W, H);

        ref[3] = ref[3] + GRAV * dt;   // vy += gravity*dt
        ref[2] = ref[2] * FRICTION;    // vx *= friction (literal, pre-S-04)
        ref[3] = ref[3] * FRICTION;    // vy *= friction (literal, pre-S-04)
        ref[0] = ref[0] + ref[2] * dt; // x += vx*dt
        ref[1] = ref[1] + ref[3] * dt; // y += vy*dt

        assert.equal(e.x[0], ref[0], 'x diverged from the calibration anchor at frame ' + f);
        assert.equal(e.y[0], ref[1], 'y diverged from the calibration anchor at frame ' + f);
        assert.equal(e.vx[0], ref[2], 'vx diverged from the calibration anchor at frame ' + f);
        assert.equal(e.vy[0], ref[3], 'vy diverged from the calibration anchor at frame ' + f);
    }
});

// --- Assertion 5: right-edge cull margin (S-06), both sides ---------------

function strokeCountingCtx() {
    const c = {
        strokes: 0,
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() { c.strokes++; },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    return c;
}

test('S-06: a spark just past w (w+1) is still alive and stroked', () => {
    const W = 800, H = 600;
    const e = new SparkEngine(2, { rng: () => 0.5 });
    e.state[0] = 1; e.x[0] = W + 1; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0;
    e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;
    const rec = strokeCountingCtx();
    e.updateAndDraw(rec, 1 / 60, W, H);
    assert.equal(e.state[0], 1);
    assert.equal(rec.strokes, 1);
});

test('S-06: a spark exactly at the w+200 margin boundary is still alive and stroked (not > w+200)', () => {
    const W = 800, H = 600;
    const e = new SparkEngine(2, { rng: () => 0.5 });
    e.state[0] = 1; e.x[0] = W + 200; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0;
    e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;
    const rec = strokeCountingCtx();
    e.updateAndDraw(rec, 1 / 60, W, H);
    assert.equal(e.state[0], 1);
    assert.equal(rec.strokes, 1);
});

test('S-06: a spark just beyond w+200 is culled -- state 0, not stroked', () => {
    const W = 800, H = 600;
    const e = new SparkEngine(2, { rng: () => 0.5 });
    e.state[0] = 1; e.x[0] = W + 200.0001; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0;
    e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;
    const rec = strokeCountingCtx();
    e.updateAndDraw(rec, 1 / 60, W, H);
    assert.equal(e.state[0], 0);
    assert.equal(rec.strokes, 0);
});

test('S-06: a spark well beyond the margin (w+201) is culled -- state 0, not stroked', () => {
    const W = 800, H = 600;
    const e = new SparkEngine(2, { rng: () => 0.5 });
    e.state[0] = 1; e.x[0] = W + 201; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0;
    e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;
    const rec = strokeCountingCtx();
    e.updateAndDraw(rec, 1 / 60, W, H);
    assert.equal(e.state[0], 0);
    assert.equal(rec.strokes, 0);
});

// --- Assertion 6: floorY (S-10) ---------------------------------------------

/** Settle a single manually-placed spark under gravity to its resting y. */
function settleFloor(config, y0, w = 800, h = 600) {
    const e = new SparkEngine(4, { rng: () => 0.5, ...config });
    e.state[0] = 1; e.x[0] = 400; e.y[0] = y0; e.vx[0] = 0; e.vy[0] = 1e-3;
    e.life[0] = 1000; e.invLife[0] = 1 / 1000; e.weight[0] = 2;
    for (let f = 0; f < 100; f++) e.updateAndDraw(ctx, 0.1, w, h);
    return e;
}

test('S-10: default floorY:null lands at h - weight/2 byte-identically to the prior h-based floor', () => {
    const e = settleFloor({}, 100);
    const expected = 600 - e.weight[0] / 2;
    assert.equal(e.y[0], expected);
});

test('S-10: custom floorY:200 lands the spark near y=200 - weight/2, not at h', () => {
    const e = settleFloor({ floorY: 200 }, 100);
    const expected = 200 - e.weight[0] / 2;
    assert.equal(e.y[0], expected);
    assert.notEqual(e.y[0], 600 - e.weight[0] / 2); // did NOT fall through to h
});

test('S-10: floorY:0 is HONORED (spark lands near y=0, not treated as "use h") -- null is not zero', () => {
    // Spawn above the floorY:0 line (negative y) with a small downward vy so it
    // is not asleep, and let it fall onto floorY:0. If the engine ever used
    // `config.floorY || h` instead of an explicit `== null` check, floorY:0
    // (falsy) would silently fall back to h=600 -- this test would then fail.
    const e = settleFloor({ floorY: 0 }, -50);
    const expected = 0 - e.weight[0] / 2;
    assert.equal(e.y[0], expected);
    assert.notEqual(e.y[0], 600 - e.weight[0] / 2); // did NOT silently become h
    assert.ok(e.y[0] < 100); // landed near the top, nowhere near the bottom
});

// --- Adversarial: dt-scaling law probed with a bounce mid-flight ----------
// The planner's dt-scaling law (assertion 2) and its unit companion above both
// deliberately fly a tall, bounce-free canvas so only friction/gravity
// discretization is in play. The adversarial case QA adds: what happens to the
// SAME law when a floor bounce (an event-driven, non-dt-scaled impulse) falls
// on a DIFFERENT frame boundary for the two schedules? A single dt step and
// two dt/2 steps can land the bounce in a different sub-step, so post-bounce
// state is allowed to diverge by much more than 1px -- restitution is
// per-EVENT, not per-frame, so this is expected physical behavior, not a bug.
// Pin that the un-scaled law does NOT hold across a bounce, so nobody mistakes
// "dt-scaling holds in free flight" for "dt-scaling holds unconditionally".
test('adversarial: dt-scaling tolerance is free-flight-only -- a mid-step floor bounce is allowed to diverge > 1px', () => {
    const DT = 1 / 30;
    const W = 800, H = 600; // floor is reachable this time

    const seed = (e) => {
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 595; // just above the floor
        e.vx[0] = 50; e.vy[0] = 300; // falling fast, about to hit the floor
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
    };

    const big = new SparkEngine(4, { rng: () => 0.5 });
    const half = new SparkEngine(4, { rng: () => 0.5 });
    seed(big); seed(half);

    big.updateAndDraw(ctx, DT, W, H);
    half.updateAndDraw(ctx, DT / 2, W, H);
    half.updateAndDraw(ctx, DT / 2, W, H);

    // Both bounced (restitution engaged -- vy sign should differ from a pure
    // free-flight continuation), but the exact post-bounce vy/x is allowed to
    // diverge beyond the free-flight tolerance because the bounce landed on
    // different sub-steps. This is documented, not asserted as a bug: we only
    // pin that at least one of the four channels now exceeds the 1px/1(px/s)
    // free-flight tolerance, so nobody silently tightens the law to cover
    // event-driven restitution.
    const divergedBeyondFreeFlightTolerance =
        Math.abs(big.x[0] - half.x[0]) >= 1 ||
        Math.abs(big.y[0] - half.y[0]) >= 1 ||
        Math.abs(big.vx[0] - half.vx[0]) >= 1 ||
        Math.abs(big.vy[0] - half.vy[0]) >= 1;
    assert.ok(divergedBeyondFreeFlightTolerance,
        'expected a mid-step bounce to break the free-flight dt-scaling tolerance, but it did not -- ' +
        'either the scenario no longer bounces on a split sub-step, or restitution silently became dt-scaled');
});
