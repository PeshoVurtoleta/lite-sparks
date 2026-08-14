/**
 * @zakkster/lite-sparks -- QA boundary coverage.
 *
 * S1 (v1.0.2) FLIPPED the S-01/S-02 anchors from the v1.0.1 buggy behavior to
 * the fixed behavior now that the hostile-input doors are closed:
 *   - S-01: a non-finite `dt` is a no-op frame -- live particles stay finite.
 *   - S-02: `burst(0|NaN|-5|null|undefined|-0)` spawns 0; `1.5` spawns 1; a valid
 *     count spawns `min(count, freeSlots)`.
 * The S-05 anchor stays pinned to the v1.0.1 (buggy) mid-air-hang behavior --
 * that is S2's sleep-epsilon fix, not S1's; its life (5) is untouched by the
 * S-11 clamp. Do not "fix" an assertion here without a corresponding
 * SparkEngine.js change landing in the same session.
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

test('S-05: pinned v1.0.1 behavior, S2 fixes -- zero-speed burst hangs mid-air across N frames', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 100, 1, 0, 0, 0, 0, 5, 5); // speedMin=speedMax=0 -> vx=vy=0 exactly
    const yBefore = e.y[0];
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 0.1, 800, 600);
    assert.equal(e.y[0], yBefore); // gravity never engaged -- sleep check fired at spawn
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
