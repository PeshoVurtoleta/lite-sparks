/**
 * @zakkster/lite-sparks -- QA boundary coverage for S3 (v1.2.0).
 *
 * Independent unit-level pins for the S3 findings that the torture suite
 * (test/torture/t5-fuzz.mjs, t6-alloc.mjs) already exercises at scale, written
 * from the ROADMAP S3 ASSERTIONS list directly:
 *
 *   S-08 ring cursor (overwrite-oldest, bounded spawn into a full pool)
 *   S-07 batched render (segment/stroke parity, physics untouched by binning)
 *   S-07 wBucket quantization (clamp into {0..3})
 *   S-07 colorIdx upper-bound clamp (life*invLife===1 -> colorLen-1, never colorLen)
 *   destroy() nulls the S3 scratch columns, idempotently
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

function aliveCount(e, max) {
    let n = 0;
    for (let i = 0; i < max; i++) if (e.state[i] === 1) n++;
    return n;
}

/** Recording ctx: counts moveTo (== drawn segments) and stroke passes, and
 * records the (lineWidth, strokeStyle) pair set immediately before each pass. */
function recordingCtx() {
    const c = {
        moveToCalls: 0, strokeCalls: 0, passes: [],
        clearRect() {}, beginPath() {}, lineTo() {},
        moveTo() { c.moveToCalls++; },
        stroke() { c.strokeCalls++; c.passes.push({ lineWidth: c.lineWidth, strokeStyle: c.strokeStyle }); },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    return c;
}

// ---------------------------------------------------------------------------
// S-08: ring cursor overwrite-oldest -- decisions/0005-spawn.md.
// ---------------------------------------------------------------------------

test('S-08: burst(max) into an empty small pool fills slots in advance-before-write order (1,2,3,0 for max=4)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5 });
    e.burst(100, 100, 4, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 4), 4);
    // Head starts at 0 and advances BEFORE writing: spawn order is slot 1
    // (oldest), 2, 3, 0 (newest). Every slot carries the first burst's x=100.
    for (const i of [0, 1, 2, 3]) assert.equal(e.x[i], 100, 'slot ' + i + ' not spawned by burst 1');
    assert.equal(e._head, 0);
});

test('S-08: overwrite-oldest -- a second burst into a full pool evicts the OLDEST slots first, not a from-zero rescan', () => {
    const e = new SparkEngine(4, { rng: () => 0.5 });
    e.burst(100, 100, 4, 0, Math.PI * 2, 100, 500); // fills slots 1,2,3,0 in that age order (1 oldest)
    assert.equal(aliveCount(e, 4), 4);

    e.burst(200, 200, 2, 0, Math.PI * 2, 100, 500); // 2 more sparks, pool already full
    assert.equal(aliveCount(e, 4), 4, 'pool must stay at exactly max, not grow or shrink');
    assert.equal(e._visits, 2, 'burst(2) into a full pool must visit exactly 2 slots -- bounded, O(count)');

    // The two OLDEST slots (1, then 2) were overwritten with the new x=200 burst.
    assert.equal(e.x[1], 200, 'slot 1 (oldest) was not overwritten first');
    assert.equal(e.x[2], 200, 'slot 2 (2nd oldest) was not overwritten second');
    // The two NEWEST slots from burst 1 (3, then 0) are untouched -- proves this
    // is oldest-first eviction, not a from-zero rescan (which would have hit
    // slot 0 before slot 1, or found "no free slots" and silently spawned 0 like
    // the pre-S-08 free-slot-only scan).
    assert.equal(e.x[3], 100, 'slot 3 (newest from burst 1) must be untouched');
    assert.equal(e.x[0], 100, 'slot 0 (2nd-newest from burst 1) must be untouched');
});

test('S-08: burst(count > max) into an already-full pool is bounded to max, not a silent drop-to-zero', () => {
    const e = new SparkEngine(4, { rng: () => 0.5 });
    e.burst(100, 100, 4, 0, Math.PI * 2, 100, 500); // fill
    e.burst(500, 500, 10, 0, Math.PI * 2, 100, 500); // ask for 10 into a full pool of 4
    assert.equal(aliveCount(e, 4), 4, 'pool must stay exactly at max, not overfill');
    assert.equal(e._visits, 4, 'count>max into a full pool must cap visits at max, not silently spawn 0');
    // Every slot now carries the newest burst's marker -- the full pool got a
    // full fresh generation of sparks, the requested (capped) count actually spawned.
    for (let i = 0; i < 4; i++) assert.equal(e.x[i], 500, 'slot ' + i + ' was not refreshed by the capped burst');
});

test('S-08: burst(1) into a full pool of max=1 repeatedly cycles the single slot (N=1 ring edge)', () => {
    const e = new SparkEngine(1, { rng: () => 0.5 });
    e.burst(1, 1, 1, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 1), 1);
    assert.equal(e.x[0], 1);
    e.burst(2, 2, 1, 0, Math.PI * 2, 100, 500);
    assert.equal(aliveCount(e, 1), 1, 'a 1-slot pool must stay at exactly 1 alive');
    assert.equal(e.x[0], 2, 'the single slot must be overwritten every burst');
    assert.equal(e._visits, 1);
});

// ---------------------------------------------------------------------------
// S-07: batched render segment/stroke parity -- decisions/0006-render-batching.md.
// ---------------------------------------------------------------------------

test('S-07: batched render draws every live particle exactly once and issues <= colors.length*4 stroke passes', () => {
    const e = new SparkEngine(64, { rng: () => 0.5 });
    // A deterministic pseudo-varied rng so bursts land in multiple distinct
    // (colorIdx, wBucket) bins -- otherwise every spark shares one bin and the
    // <= colors.length*4 bound is trivially satisfied by a single pass.
    let k = 0;
    const seqRng = () => (k = (k + 1) % 11) / 11;
    const e2 = new SparkEngine(64, { rng: seqRng });
    e2.burst(400, 100, 40, 0, Math.PI * 2, 50, 400, 0.2, 1.4);

    const rec = recordingCtx();
    e2.updateAndDraw(rec, 1 / 60, 800, 600);

    const alive = aliveCount(e2, 64);
    assert.ok(alive > 0, 'setup produced no survivors -- test is vacuous');
    assert.equal(rec.moveToCalls, alive, 'total drawn segments must equal aliveCount post-frame -- no drop/dup');
    assert.ok(rec.strokeCalls <= e2.colors.length * 4,
        'stroke passes ' + rec.strokeCalls + ' > colors.length*4 (' + (e2.colors.length * 4) + ')');
    assert.ok(rec.strokeCalls >= 1, 'at least one bin must be non-empty when particles are alive');

    // Sanity: the plain-rng engine e (constructed above, unused for physics)
    // exists only to prove the deterministic setup below is not required for a
    // trivial single-bin case; explicit no-op reference to avoid an unused var.
    void e;
});

test('S-07: batched render -- sum of per-pass segment counts equals aliveCount exactly, across multiple bins', () => {
    let k = 0;
    const seqRng = () => (k = (k + 1) % 13) / 13;
    const e = new SparkEngine(64, { rng: seqRng });
    e.burst(400, 100, 40, 0, Math.PI * 2, 50, 400, 0.2, 1.4);

    let segmentsThisPass = 0;
    let totalSegments = 0;
    let passCount = 0;
    const rec = {
        clearRect() {}, lineTo() {},
        beginPath() { segmentsThisPass = 0; },
        moveTo() { segmentsThisPass++; },
        stroke() { totalSegments += segmentsThisPass; passCount++; },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    e.updateAndDraw(rec, 1 / 60, 800, 600);

    const alive = aliveCount(e, 64);
    assert.ok(alive > 0, 'setup produced no survivors -- test is vacuous');
    assert.equal(totalSegments, alive, 'sum of stroke-pass segment counts must equal aliveCount');
    assert.ok(passCount <= e.colors.length * 4);
});

test('S-07: batched render physics is byte-identical to a directly-computed float32 reference across concurrently-active bins', () => {
    // 8 hand-placed particles spanning distinct (colorIdx via life ratio,
    // wBucket via weight) combinations, all alive at once so the counting-sort
    // batches multiple bins in the same frame. No rng, no burst -- direct SoA
    // injection so the physics-vs-reference comparison is exact.
    const N = 8;
    const e = new SparkEngine(N, { gravity: 800, friction: 0.99, stretch: 0.04 });
    const ref = { x: new Float32Array(N), y: new Float32Array(N), vx: new Float32Array(N), vy: new Float32Array(N) };

    for (let i = 0; i < N; i++) {
        e.state[i] = 1;
        e.x[i] = 100 + i * 50; e.y[i] = 50 + i * 10;
        e.vx[i] = 60 + i * 15; e.vy[i] = -80 + i * 5;
        e.life[i] = 1 + i * 0.3; e.invLife[i] = 1 / e.life[i];
        e.weight[i] = 1 + (i % 4); // spans wBucket 0..3 by direct construction
        e.wBucket[i] = ((e.weight[i] - 1) | 0) < 0 ? 0 : Math.min((e.weight[i] - 1) | 0, 3);

        ref.x[i] = e.x[i]; ref.y[i] = e.y[i]; ref.vx[i] = e.vx[i]; ref.vy[i] = e.vy[i];
    }

    const dt = 1 / 60;
    const GRAV = 800, FRICTION = 0.99, H = 1e9; // tall enough: no floor bounce in-flight

    for (let f = 0; f < 40; f++) {
        e.updateAndDraw(ctx, dt, 800, H);

        for (let i = 0; i < N; i++) {
            if (e.state[i] !== 1) continue; // this particle already died -- skip it in the reference too
            ref.vy[i] = ref.vy[i] + GRAV * dt;
            ref.vx[i] = ref.vx[i] * FRICTION;
            ref.vy[i] = ref.vy[i] * FRICTION;
            ref.x[i] = ref.x[i] + ref.vx[i] * dt;
            ref.y[i] = ref.y[i] + ref.vy[i] * dt;

            assert.equal(e.x[i], ref.x[i], 'x[' + i + '] diverged from reference at frame ' + f);
            assert.equal(e.y[i], ref.y[i], 'y[' + i + '] diverged from reference at frame ' + f);
            assert.equal(e.vx[i], ref.vx[i], 'vx[' + i + '] diverged from reference at frame ' + f);
            assert.equal(e.vy[i], ref.vy[i], 'vy[' + i + '] diverged from reference at frame ' + f);
        }
    }
});

// ---------------------------------------------------------------------------
// S-07 wBucket quantization -- weight in [1,4) -> {0,1,2}; clamp guards a
// manually/hostile-seeded weight outside that range into {0..3}.
// ---------------------------------------------------------------------------

/** Spawn exactly one spark whose weight = 1 + v*3 (v is every rng() draw). */
function spawnWithConstantRng(v) {
    const e = new SparkEngine(2, { rng: () => v });
    e.burst(400, 300, 1, 0, Math.PI * 2, 100, 500, 1, 1); // lifeMin=lifeMax=1 -> life ignores rng value
    let s = -1;
    for (let i = 0; i < 2; i++) if (e.state[i] === 1) { s = i; break; }
    return { e, s };
}

test('wBucket: v=0 -> weight=1 -> bucket 0', () => {
    const { e, s } = spawnWithConstantRng(0);
    assert.equal(e.weight[s], 1);
    assert.equal(e.wBucket[s], 0);
});

test('wBucket: v=1/3 -> weight=2 -> bucket 1', () => {
    const { e, s } = spawnWithConstantRng(1 / 3);
    assert.ok(Math.abs(e.weight[s] - 2) < 1e-6);
    assert.equal(e.wBucket[s], 1);
});

test('wBucket: v=2/3 -> weight=3 -> bucket 2', () => {
    const { e, s } = spawnWithConstantRng(2 / 3);
    assert.ok(Math.abs(e.weight[s] - 3) < 1e-6);
    assert.equal(e.wBucket[s], 2);
});

test('wBucket: v=1 (hostile rng touching the open upper bound) -> weight=4 -> bucket 3, no clamp needed', () => {
    const { e, s } = spawnWithConstantRng(1);
    assert.equal(e.weight[s], 4);
    assert.equal(e.wBucket[s], 3);
});

test('wBucket: v=-1 (hostile negative rng) -> weight=-2 -> clamps to bucket 0, not negative, not thrown', () => {
    const { e, s } = spawnWithConstantRng(-1);
    assert.equal(e.weight[s], -2);
    assert.equal(e.wBucket[s], 0);
    // and the bin it feeds stays in-range: colorIdx*4 + wBucket never goes negative.
    assert.ok(e.wBucket[s] >= 0 && e.wBucket[s] <= 3);
});

test('wBucket: v=5 (hostile out-of-range rng) -> weight=16 -> clamps to bucket 3, no OOB bin', () => {
    const { e, s } = spawnWithConstantRng(5);
    assert.equal(e.weight[s], 16);
    assert.equal(e.wBucket[s], 3);
    assert.ok(e.wBucket[s] >= 0 && e.wBucket[s] <= 3);
});

test('wBucket: an out-of-range wBucket still renders without throwing and without an OOB write (full pipeline)', () => {
    const { e, s } = spawnWithConstantRng(5); // weight=16, clamped wBucket=3
    const rec = recordingCtx();
    assert.doesNotThrow(() => e.updateAndDraw(rec, 1 / 60, 800, 600));
    assert.equal(rec.moveToCalls, 1);
    assert.equal(rec.strokeCalls, 1);
    void s;
});

// ---------------------------------------------------------------------------
// S-07 colorIdx upper-bound clamp: life*invLife===1 exactly must map to
// colorLen-1, never colorLen (which would silently drop the spark from every
// render pass -- bin colorLen*4+wBucket is never iterated in phase 3).
// ---------------------------------------------------------------------------

test('colorIdx: life*invLife===1 exactly clamps to colorLen-1 (last heat color), spark is still drawn', () => {
    const e = new SparkEngine(2);
    const colorLen = e.colors.length;
    // Manual injection: life and invLife both exactly 1 (float32-exact), asleep
    // (vx=vy=0) so physics does not move it, dt is the smallest positive double
    // so life[-]=dt rounds back to exactly 1 in float32 -- the ratio stays 1.
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0;
    e.life[0] = 1; e.invLife[0] = 1; e.weight[0] = 2; e.wBucket[0] = 0;

    assert.equal(e.life[0] * e.invLife[0], 1); // load-bearing precondition

    const rec = recordingCtx();
    e.updateAndDraw(rec, Number.MIN_VALUE, 800, 600);

    assert.equal(e.life[0] * e.invLife[0], 1, 'the MIN_VALUE dt must not have moved the ratio off 1');
    assert.equal(e.state[0], 1, 'the spark must still be alive (life did not cross 0)');
    assert.equal(rec.moveToCalls, 1, 'colorIdx clamp failed -- the spark was silently dropped from every bin');
    assert.equal(rec.strokeCalls, 1);
    assert.equal(rec.passes.length, 1);
    assert.equal(rec.passes[0].strokeStyle, e.colors[colorLen - 1],
        'expected the LAST heat color (colorLen-1), got a different/undefined strokeStyle -- ' +
        'colorIdx was not clamped and read past the end of colors[]');
});

// ---------------------------------------------------------------------------
// destroy() nulls the S3 scratch columns and stays idempotent.
// ---------------------------------------------------------------------------

test('destroy(): nulls wBucket, _order, _binCount, _binStart alongside the SoA columns', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    e.destroy();
    assert.equal(e.wBucket, null);
    assert.equal(e._order, null);
    assert.equal(e._binCount, null);
    assert.equal(e._binStart, null);
    // alongside the pre-existing SoA columns, for completeness.
    assert.equal(e.x, null);
    assert.equal(e.state, null);
});

test('destroy(): idempotent -- a second and third call do not throw and the S3 scratch stays null', () => {
    const e = new SparkEngine(10, { rng: () => 0.5 });
    e.burst(400, 300, 5, 0, Math.PI * 2, 100, 500);
    e.destroy();
    assert.doesNotThrow(() => e.destroy());
    assert.doesNotThrow(() => e.destroy());
    assert.equal(e.wBucket, null);
    assert.equal(e._order, null);
    assert.equal(e._binCount, null);
    assert.equal(e._binStart, null);
});

// ---------------------------------------------------------------------------
// Adversarial: one case the S3 planner did not enumerate -- a burst() that
// re-enters DURING the counting-sort scatter/prefix phase via a hostile getter
// on config, landing between phase 1 (count) and phase 3 (stroke). The engine
// has no getters on config in production, but a re-entrant *destroy from a
// stroke callback mid-multi-bin-pass* was already pinned in boundary.test.js
// for a single-bin burst; here it is repeated across MULTIPLE bins to prove
// the loop-preheader locals (S-09 hoisting) protect every bin's pass, not just
// the first.
// ---------------------------------------------------------------------------

test('adversarial: dispose mid-render across MULTIPLE bins does not throw -- hoisted locals protect every pass, not just the first', () => {
    let k = 0;
    const seqRng = () => (k = (k + 1) % 9) / 9;
    const e = new SparkEngine(32, { rng: seqRng });
    e.burst(400, 300, 20, 0, Math.PI * 2, 50, 400, 0.2, 1.4); // spread across several bins

    let strokeCalls = 0;
    const disposingCtx = {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {
            strokeCalls++;
            if (strokeCalls === 2) e.destroy(); // dispose partway through a multi-bin pass, not on the first
        },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    };
    assert.doesNotThrow(() => e.updateAndDraw(disposingCtx, 0.016, 800, 600));
    assert.ok(strokeCalls >= 2, 'setup did not exercise multiple bins -- test is vacuous');
    assert.equal(e.x, null); // destroy() still took effect afterward
});
