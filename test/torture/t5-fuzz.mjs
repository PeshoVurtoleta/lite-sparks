/**
 * T5 -- differential fuzz + batched-render purity.
 *
 * Two jobs, both filled in S3:
 *
 *   A. Render purity (the S-07 batching witness). Over 600 deterministic frames a
 *      recording ctx accumulates an order-independent XOR fingerprint of every
 *      DRAWN head endpoint (`moveTo`). It must equal the fingerprint of the live
 *      SoA state after the frame -- proving the counting-sort render draws every
 *      live spark exactly once, at its true byte-identical position, and drops /
 *      duplicates / moves nothing. Stroke submissions per frame must be <=
 *      colors.length*4 (16), down from one per particle. A committed run
 *      fingerprint pins the physics: the endpoints are byte-identical to v1.1.0
 *      (the render is a pure reorder + width-bucket; ADR 0006), so this constant
 *      is the v1.1.0 position hash and any physics regression moves it.
 *
 *   B. 100k-op differential fuzz. Random valid/hostile burst args, random dt
 *      (valid + hostile), random degenerate w/h, and random VALID live-config
 *      mutation, checked after EVERY op against the invariant oracle: every
 *      state[i] in {0,1}, aliveCount <= max, and every live particle finite. The
 *      hostile-input doors (S-01/S-02/S-11) give the oracle a defined answer.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { makePrng, SEED, check, stubCtx, aliveCount, aliveFinite } from './harness.mjs';

const TAU = Math.PI * 2;

// Bit-exact reinterpret of a float as its (float32) unsigned bit pattern, so the
// XOR fingerprint is order-independent AND exact (float addition is not).
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function bits(v) { _f32[0] = v; return _u32[0]; }

/** Committed run fingerprint for the default seed (physics regression pin). */
const RENDER_FINGERPRINT = 454851317; // 600-frame default-seed position hash

function makeFloatRng(seed) {
    const prng = makePrng(seed);
    return () => prng() / 4294967296;
}

// ---- Part A: batched-render purity ---------------------------------------
function renderPurity() {
    const MAX = 2048;
    const W = 800, H = 600;
    const FRAMES = 600;
    const engine = new SparkEngine(MAX, { rng: makeFloatRng(SEED) });
    const colorLen = engine.colors.length;
    const maxStrokePasses = colorLen * 4;

    // Recording ctx: XORs every drawn head endpoint and counts stroke() calls.
    let drawnHash = 0;
    let strokes = 0;
    const recCtx = {
        clearRect() {}, beginPath() {}, lineTo() {},
        moveTo(x, y) { drawnHash = (drawnHash ^ bits(x) ^ bits(y)) >>> 0; },
        stroke() { strokes++; },
        strokeStyle: '', lineWidth: 1, lineCap: 'butt', globalCompositeOperation: 'source-over',
    };

    let runHash = 0;
    for (let fr = 0; fr < FRAMES; fr++) {
        // Modest bursts into a large pool: total spawns stay well under MAX so the
        // ring never wraps onto a live slot -- the drawn multiset is exactly the
        // v1.1.0 append multiset (offset by one slot), which XOR ignores.
        if ((fr % 4) === 0) engine.burst(W / 2, 120, 8, -TAU / 2, 0, 60, 420, 0.3, 0.9);

        drawnHash = 0;
        strokes = 0;
        engine.updateAndDraw(recCtx, 1 / 60, W, H);

        // State fingerprint over the post-frame live set (culled sparks already
        // have state===0), computed by index scan -- a DIFFERENT order than the
        // bin-sorted draw order, so equality proves order-independence too.
        let stateHash = 0;
        for (let i = 0; i < MAX; i++) {
            if (engine.state[i] !== 1) continue;
            stateHash = (stateHash ^ bits(engine.x[i]) ^ bits(engine.y[i])) >>> 0;
        }

        check(drawnHash === stateHash,
            () => 'T5.render: frame ' + fr + ' drew a set that differs from live state ' +
                  '(drawn=' + drawnHash + ' state=' + stateHash + ') -- batching dropped/dup/moved a spark');
        check(strokes <= maxStrokePasses,
            () => 'T5.render: frame ' + fr + ' issued ' + strokes + ' stroke passes > ' + maxStrokePasses);

        runHash = (Math.imul(runHash ^ stateHash, 2654435761) + 0x6d2b79f5) >>> 0;
    }

    // The fingerprint is only pinned for the default seed (the committed value).
    if (SEED === 0x9e3779b9) {
        check(runHash === RENDER_FINGERPRINT,
            () => 'T5.render: 600-frame position fingerprint moved -- got ' + runHash +
                  ' want ' + RENDER_FINGERPRINT + ' (physics regression vs v1.1.0)');
    }
}

// ---- Part B: 100k-op differential fuzz -----------------------------------
function fuzz() {
    const MAX = 256;
    const W = 800, H = 600;
    const OPS = 100000;
    const engine = new SparkEngine(MAX, { rng: makeFloatRng(SEED ^ 0x5bd1e995) });
    const rnd = makePrng(SEED ^ 0x27d4eb2f);
    const u = () => rnd() / 4294967296;

    // A pool of dt values: valid, hostile (rejected -> no-op), and clamped.
    const DTS = [1 / 60, 1 / 30, 1 / 120, 0.05, 0, -1, NaN, Infinity, -Infinity, 1e9, 1e-45];
    // Hostile + valid burst counts.
    const COUNTS = [1, 4, 16, 64, 300, 0, -5, NaN, Infinity, 1.5];
    // Degenerate + valid dimensions.
    const DIMS = [W, H, 0, -1, NaN];
    // Valid finite config values only -- the oracle needs a defined answer.
    const KEYS = ['gravity', 'friction', 'floorFriction', 'restitution', 'stretch'];

    for (let op = 0; op < OPS; op++) {
        const action = rnd() % 4;
        if (action === 0) {
            const count = COUNTS[rnd() % COUNTS.length];
            const a0 = u() * TAU, a1 = u() * TAU;
            engine.burst(u() * W, u() * H, count, a0, a1, u() * 200, 200 + u() * 600, 0.2 + u(), 0.5 + u());
        } else if (action === 1) {
            const dt = DTS[rnd() % DTS.length];
            const w = DIMS[rnd() % DIMS.length];
            const h = DIMS[rnd() % DIMS.length];
            engine.updateAndDraw(stubCtx, dt, w, h);
        } else if (action === 2) {
            // VALID live config mutation (finite, in-range).
            const key = KEYS[rnd() % KEYS.length];
            engine.config[key] = u() * (key === 'gravity' ? 2000 : 1);
        } else {
            // A normal frame with valid dt so the pool actually advances/drains.
            engine.updateAndDraw(stubCtx, 1 / 60, W, H);
        }

        // Invariant oracle -- checked after EVERY op.
        const alive = aliveCount(engine);
        check(alive <= MAX,
            () => 'T5.fuzz: op ' + op + ' left aliveCount ' + alive + ' > ' + MAX);
        check(aliveFinite(engine),
            () => 'T5.fuzz: op ' + op + ' left a non-finite live particle (a door leaked)');
        for (let i = 0; i < MAX; i++) {
            const s = engine.state[i];
            if (s > 1) {
                check(false, () => 'T5.fuzz: op ' + op + ' state[' + i + ']=' + s + ' not in {0,1}');
            }
        }
    }
}

export function run() {
    renderPurity();
    fuzz();
}
