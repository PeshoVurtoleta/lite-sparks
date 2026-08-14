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

import { SparkEngine } from '../../SparkEngine.js';
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
    }

    check(tracker.size() === 0,
        () => 'T7: lite-leak tracker leaked ' + tracker.size() + ' resources');

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const grewKB = (heapAfter - heapBefore) / 1024;
    check(grewKB < 512, () => 'T7: heap grew ' + grewKB.toFixed(1) + ' KB over ' + CYCLES + ' cycles');
}
