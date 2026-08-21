/**
 * T7 -- soak and conservation.
 *
 * `CYCLES` build / run-to-death / teardown cycles. Each cycle bursts a full
 * pool, then drains it two ways on alternating cycles -- run every particle to
 * death (life decrement), or `clear()` -- so both drain paths soak. After each
 * cycle the pool must return to empty (`aliveCount === 0`, the S-05 stuck-alive
 * detector) and every column stays finite.
 *
 * `createLeakTracker` from @zakkster/lite-leak is the independent second
 * witness: a per-cycle JS resource is tracked and untracked, and the tracker
 * must return to size 0 -- so a stuck particle and a JS-object leak cannot hide
 * behind each other. The held-value contract is honored: the cleanup thunk and
 * the tag close over neither the tracked target nor anything reaching it.
 *
 * Heap is sampled ACROSS cycles (after gc, at boundaries), never within one, so
 * intra-cycle churn is not misread as growth.
 */

import { SparkEngine, makeEmitter } from '../../SparkEngine.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, stubCtx, aliveCount, aliveFinite } from './harness.mjs';

const CYCLES = 4096;
const MAX = 64;
const W = 800;
const H = 600;
const TAU = Math.PI * 2;
const DRAIN_FRAMES = 40; // dt=0.1, max life 1.5 -> exhausted in <=15 frames
const NOOP = function () {};

export function run() {
    const engine = new SparkEngine(MAX, { rng: () => 0.5 });
    // S-14 containment lane. A wall-contained spark NEVER X-culls, so the pool
    // drains ONLY by life expiry + ring eviction -- the soak MUST cover walls-on
    // to prove a contained pool still returns to empty every cycle (ADR 0009). The
    // bounds/center sit inside the canvas so the hot `if (walls)` + vortex branch
    // run every frame; run-to-death (life <= 0) is the only drain here.
    const contain = new SparkEngine(MAX, {
        rng: () => 0.5,
        wallLeft: 100, wallRight: 700, ceiling: 50,
        attract: 2000, swirl: 500, attractX: W / 2, attractY: H / 2,
    });
    // S-15 emitter drain lane. A fractional-carry emitter fills the pool over a
    // few steps, is then STOPPED (no more steps), and the pool is run to death.
    // The engine holds no reference to the emitter, so the pool must drain to
    // empty by life expiry alone -- a stopped emitter leaks no live spark (ADR
    // 0011). Short life (<= 1.0) so DRAIN_FRAMES (4s) exhausts every spark.
    const emitEngine = new SparkEngine(MAX, { rng: () => 0.5 });
    const emitter = makeEmitter({ x: W / 2, y: H / 2, rate: 400, cone: 0.6, speed: 500, life: 1.0 });
    const tracker = createLeakTracker({ name: 'sparks-soak' });

    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let c = 0; c < CYCLES; c++) {
        engine.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);
        check(aliveCount(engine) === MAX,
            () => 'T7: cycle ' + c + ' burst filled ' + aliveCount(engine) + ' != ' + MAX);

        // A tracked external resource modelling a per-cycle allocation. The tag
        // is a primitive and the cleanup is a shared no-op -- neither captures
        // the tracked target (the lite-leak held-value contract).
        const h = tracker.track({ cycle: c }, NOOP, c);

        // Alternate the two drain paths so clear() is soaked too.
        if (c & 1) {
            for (let f = 0; f < DRAIN_FRAMES; f++) engine.updateAndDraw(stubCtx, 0.1, W, H);
        } else {
            engine.clear();
        }
        tracker.untrack(h);

        check(aliveCount(engine) === 0,
            () => 'T7: cycle ' + c + ' left ' + aliveCount(engine) + ' alive (stuck particle -- S-05)');
        check(aliveFinite(engine),
            () => 'T7: cycle ' + c + ' left a non-finite live particle');

        // Containment lane: full pool, run-to-death every cycle. Wall-contained
        // sparks cannot X-cull, so this proves life expiry alone drains the pool.
        contain.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);
        check(aliveCount(contain) === MAX,
            () => 'T7.contain: cycle ' + c + ' burst filled ' + aliveCount(contain) + ' != ' + MAX);
        for (let f = 0; f < DRAIN_FRAMES; f++) contain.updateAndDraw(stubCtx, 0.1, W, H);
        check(aliveCount(contain) === 0,
            () => 'T7.contain: cycle ' + c + ' left ' + aliveCount(contain) +
                  ' alive -- a contained spark did not drain by life expiry (S-14)');
        check(aliveFinite(contain),
            () => 'T7.contain: cycle ' + c + ' left a non-finite live particle');

        // Emitter drain lane: step the emitter to FILL, then STOP it and run to
        // death. A few high-rate steps fill the pool (rate 400/s, dt 1/60 ~ 6.7
        // sparks/step); after 10 steps the pool is non-empty. Then no more steps
        // (the emitter is stopped) and the pool is run to death -- it MUST return
        // to empty, proving a stopped emitter leaks no live spark.
        emitter.carry = 0; // reset the accumulator each cycle (fresh fill)
        for (let s = 0; s < 10; s++) { emitter.step(emitEngine, 1 / 60); emitEngine.updateAndDraw(stubCtx, 1 / 60, W, H); }
        check(aliveCount(emitEngine) > 0,
            () => 'T7.emitter: cycle ' + c + ' emitter filled 0 sparks -- the fill is vacuous');
        for (let f = 0; f < DRAIN_FRAMES; f++) emitEngine.updateAndDraw(stubCtx, 0.1, W, H);
        check(aliveCount(emitEngine) === 0,
            () => 'T7.emitter: cycle ' + c + ' left ' + aliveCount(emitEngine) +
                  ' alive after a stopped emitter drained -- a spark did not die (S-15)');
        check(aliveFinite(emitEngine),
            () => 'T7.emitter: cycle ' + c + ' left a non-finite live particle');
    }

    check(tracker.size() === 0,
        () => 'T7: lite-leak tracker leaked ' + tracker.size() + ' resources');

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const grewKB = (heapAfter - heapBefore) / 1024;
    check(grewKB < 512, () => 'T7: heap grew ' + grewKB.toFixed(1) + ' KB over ' + CYCLES + ' cycles');
}
