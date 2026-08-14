/**
 * T0 -- metamorphic laws. Properties that must hold for ANY scene.
 *
 *   1. Burst conservation. After a VALID burst (count a positive integer),
 *      `aliveCount` equals `min(count, freeSlots)` -- no orphaned or duplicate
 *      slots. This is the structural pool invariant, the particle-engine
 *      analogue of lite-bvh's free-list conservation.
 *   2. Seeded determinism. Two engines fed the same seeded rng and the same
 *      burst/update script produce a byte-identical snapshot of
 *      x/y/vx/vy/life/state after N frames. (Shared-law 7.)
 *   3. S-01 quarantine (fixed v1.0.2). A poison-dt frame is a no-op: 10k good
 *      frames + one NaN-dt frame + 10k more produce a snapshot byte-identical to
 *      a never-poisoned run. One bad frame cannot perturb the engine at all.
 *
 * Laws 1-2 already held on v1.0.1 for VALID input; law 3 is the executable form
 * of the S-01 door closing this session.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { makePrng, SEED, check, stubCtx, aliveCount, aliveFinite } from './harness.mjs';

const FRAMES = 30;
const QUARANTINE_FRAMES = 10000;

/** A deterministic float-in-[0,1) source from the seeded xorshift32. */
function makeFloatRng(seed) {
    const prng = makePrng(seed);
    return () => prng() / 4294967296;
}

export function run() {
    // --- Law 1: burst conservation on valid counts -------------------------
    {
        const max = 200;
        const e = new SparkEngine(max, { rng: makeFloatRng(SEED) });

        // Empty pool, count well under capacity -> exactly count alive.
        e.burst(400, 300, 50, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e) === 50,
            () => 'T0.conservation: burst(50) on empty pool -> alive ' + aliveCount(e) + ' != 50 (seed=' + SEED + ')');

        // Free slots now 150; a burst larger than free must fill exactly the
        // free slots -> min(count, freeSlots).
        e.burst(400, 300, 500, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e) === max,
            () => 'T0.conservation: burst over-capacity -> alive ' + aliveCount(e) + ' != ' + max + ' (seed=' + SEED + ')');

        // count exactly equal to free slots (0 here) adds nothing.
        e.burst(400, 300, 1, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e) === max,
            () => 'T0.conservation: burst into a full pool changed count to ' + aliveCount(e) + ' (seed=' + SEED + ')');

        // count == free exactly on a partially-drained pool.
        const e2 = new SparkEngine(64, { rng: makeFloatRng(SEED) });
        e2.burst(0, 0, 64, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e2) === 64,
            () => 'T0.conservation: burst(free==count) -> alive ' + aliveCount(e2) + ' != 64 (seed=' + SEED + ')');
    }

    // --- Law 2: seeded determinism ----------------------------------------
    {
        const max = 128;
        const a = new SparkEngine(max, { rng: makeFloatRng(SEED) });
        const b = new SparkEngine(max, { rng: makeFloatRng(SEED) });

        // Identical burst script + identical frame stepping.
        const step = (e, f) => {
            if ((f % 5) === 0) e.burst(400, 100, 8, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
            e.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        };
        for (let f = 0; f < FRAMES; f++) { step(a, f); step(b, f); }

        // Byte-identical snapshot across all six columns.
        for (let i = 0; i < max; i++) {
            check(a.state[i] === b.state[i],
                () => 'T0.determinism: state[' + i + '] diverged (seed=' + SEED + ')');
            check(Object.is(a.x[i], b.x[i]) && Object.is(a.y[i], b.y[i]),
                () => 'T0.determinism: position[' + i + '] diverged (seed=' + SEED + ')');
            check(Object.is(a.vx[i], b.vx[i]) && Object.is(a.vy[i], b.vy[i]),
                () => 'T0.determinism: velocity[' + i + '] diverged (seed=' + SEED + ')');
            check(Object.is(a.life[i], b.life[i]),
                () => 'T0.determinism: life[' + i + '] diverged (seed=' + SEED + ')');
        }
    }

    // --- Law 3: S-01 quarantine -------------------------------------------
    // `poisoned` runs an identical good-frame script to `clean`, but between the
    // two halves it takes one NaN-dt frame. The door makes that frame a no-op
    // (no rng, no state change), so the final snapshots must be byte-identical.
    {
        const max = 64;
        const clean = new SparkEngine(max, { rng: makeFloatRng(SEED) });
        const poisoned = new SparkEngine(max, { rng: makeFloatRng(SEED) });

        const good = (e, f) => {
            if ((f % 7) === 0) e.burst(400, 100, 6, 0, Math.PI * 2, 50, 400, 0.2, 0.8);
            e.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        };

        for (let f = 0; f < QUARANTINE_FRAMES; f++) { good(clean, f); good(poisoned, f); }

        // The single poison frame -- must be a pure no-op on `poisoned`.
        poisoned.updateAndDraw(stubCtx, NaN, 800, 600);
        check(aliveFinite(poisoned),
            () => 'T0.quarantine: NaN-dt frame poisoned a live particle (S-01)');

        for (let f = QUARANTINE_FRAMES; f < 2 * QUARANTINE_FRAMES; f++) { good(clean, f); good(poisoned, f); }

        for (let i = 0; i < max; i++) {
            check(clean.state[i] === poisoned.state[i],
                () => 'T0.quarantine: state[' + i + '] diverged after a poison frame (S-01, seed=' + SEED + ')');
            check(Object.is(clean.x[i], poisoned.x[i]) && Object.is(clean.y[i], poisoned.y[i]) &&
                  Object.is(clean.vx[i], poisoned.vx[i]) && Object.is(clean.vy[i], poisoned.vy[i]) &&
                  Object.is(clean.life[i], poisoned.life[i]),
                () => 'T0.quarantine: column[' + i + '] diverged after a poison frame (S-01, seed=' + SEED + ')');
        }
    }
}
