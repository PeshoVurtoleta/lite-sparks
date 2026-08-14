/**
 * @zakkster/lite-sparks -- torture harness.
 *
 * Shared scratch, a seeded PRNG, thunk-assertions, the structural pool
 * invariants (a particle engine's analogue of lite-bvh's free-list
 * `conservation()`), and the lite-gc-profiler gate wrapper. Every tier imports
 * from here so the discipline is enforced in one place:
 *
 *   - All scratch (the engine, a stub `ctx`) is allocated ONCE by the tier,
 *     outside every loop. This module hands out helpers, never per-call
 *     allocations on a hot path.
 *   - `check()` builds its message string only on failure -- a per-iteration
 *     template literal is an allocation and would fail the T6 gate.
 *   - The PRNG is a seeded xorshift32. On any failure a tier prints the seed so
 *     the case replays with `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially,
 *     never nested. `runOpsGate` opens and closes a single window per call.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into T6. */
export const BREAK = process.env.SPARKS_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * A no-op Canvas2D context. Every method is a bare `() => {}` and every piece
 * of pipeline state is a plain field, so a full `updateAndDraw` render pass
 * touches it without allocating a single byte -- the gate measures the engine,
 * not the canvas.
 */
export const stubCtx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    save() {}, restore() {}, fillRect() {}, arc() {}, fill() {},
    strokeStyle: '', lineWidth: 1, lineCap: 'butt', globalCompositeOperation: 'source-over',
};

/**
 * Count of live slots -- the structural pool invariant. A cheap O(max) scan any
 * corruption violates immediately (orphaned or duplicate slots).
 * @param {import('../../SparkEngine.js').SparkEngine} engine
 */
export function aliveCount(engine) {
    const state = engine.state;
    let n = 0;
    for (let i = 0; i < engine.max; i++) if (state[i] === 1) n++;
    return n;
}

/**
 * True iff every live particle's x, y, vx, vy, life is finite -- the direct
 * structural form of the S-01 poison detector. It fails the instant a poisoned
 * `dt` lands, where a heap gate never would.
 * @param {import('../../SparkEngine.js').SparkEngine} engine
 */
export function aliveFinite(engine) {
    const { state, x, y, vx, vy, life, max } = engine;
    for (let i = 0; i < max; i++) {
        if (state[i] !== 1) continue;
        if (!(Number.isFinite(x[i]) && Number.isFinite(y[i]) &&
              Number.isFinite(vx[i]) && Number.isFinite(vy[i]) &&
              Number.isFinite(life[i]))) {
            return false;
        }
    }
    return true;
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so the `maxArrayBuffersGrowth` rule
 * is resolvable (the eight SoA Float32/Uint8 columns are ArrayBuffer backing
 * stores that live OUTSIDE the V8 heap and are invisible to a heapUsed gate).
 * Returns the checkNoGc report plus the raw summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}
