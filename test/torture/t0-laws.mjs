/**
 * T0 -- metamorphic laws. Properties that must hold for ANY scene.
 *
 *   1. Burst conservation. After a VALID burst (count a positive integer),
 *      `aliveCount` equals `min(count, max)` -- no orphaned or duplicate slots.
 *      This is the structural pool invariant, the particle-engine analogue of
 *      lite-bvh's free-list conservation. The ceiling is the POOL SIZE, not the
 *      free count: the S-08 ring cursor is overwrite-oldest (ADR 0005), so a
 *      burst may reuse a live slot rather than only ever filling free ones.
 *   2. Seeded determinism. Two engines fed the same seeded rng and the same
 *      burst/update script produce a byte-identical snapshot of
 *      x/y/vx/vy/life/state after N frames. (Shared-law 7.)
 *   3. S-01 quarantine (fixed v1.0.2). A poison-dt frame is a no-op: 10k good
 *      frames + one NaN-dt frame + 10k more produce a snapshot byte-identical to
 *      a never-poisoned run. One bad frame cannot perturb the engine at all.
 *   4. S-04 dt-scaling (fixed v1.1.0). One `dt` step lands within tolerance of
 *      two `dt/2` steps on x/y/vx/vy for a spark in free flight -- the frame-rate
 *      independence the `pow(friction, dt*60)` factor buys. Pre-S-04 (`v *=
 *      friction` per frame) this diverged; the T9 control proves the law can fail.
 *   5. S-03 autoClear (added v1.1.0). Default true calls `clearRect` once per
 *      frame; `autoClear:false` never does, so sparks layer over prior pixels.
 *
 * Laws 1-2 already held on v1.0.1 for VALID input; law 3 is the executable form
 * of the S-01 door closing in S1; laws 4-5 pin the S2 compositing + physics work.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { makePrng, SEED, check, stubCtx, aliveCount, aliveFinite } from './harness.mjs';

const FRAMES = 30;
const QUARANTINE_FRAMES = 10000;
const TAU = Math.PI * 2;

// --- S-13 aero fingerprints (committed, default seed) ----------------------
// AERO_OFF is the aero-off (all-knobs-0) run fingerprint. Because the aero-off
// per-particle body is byte-identical to v1.2.0 (the single `if (aero)` gate is
// false when every knob is 0; ADR 0008), this constant IS the v1.2.0 position
// fingerprint -- any physics regression on the default path moves it. The three
// per-knob constants pin the exact wind/gust/turbulence trajectories.
const AERO_OFF_HASH = 2975953379;
const WIND_HASH = 3242857792;
const GUST_HASH = 555882219;
const TURB_HASH = 1328898878;

// --- S-14 containment fingerprints (committed, default seed) ----------------
// WALL/CEIL pin the exact wall-reflected + ceiling-contained trajectories; the
// vortex pair pins the radial (attract) and tangential (swirl) fields. Each is a
// distinct scene through the same seeded emitter; none may equal AERO_OFF (that
// would mean the branch did nothing). WALL config: wallLeft 200 / wallRight 600.
// CEIL config: ceiling 450 (the burst rises ~110px from y=500, so it engages).
// VORTEX/SWIRL config: center (400, 500) -- the burst origin (ADR 0009/0010).
const WALL_HASH = 3228719645;
const CEIL_HASH = 2199078978;
const VORTEX_HASH = 359116824;
const SWIRL_HASH = 3915575544;

/** A deterministic float-in-[0,1) source from the seeded xorshift32. */
function makeFloatRng(seed) {
    const prng = makePrng(seed);
    return () => prng() / 4294967296;
}

// Bit-exact reinterpret of a float as its float32 bit pattern (exact hashing).
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function bits(v) { _f32[0] = v; return _u32[0]; }
function mix(h, v) { return (Math.imul(h ^ v, 2654435761) + 0x6d2b79f5) >>> 0; }

/**
 * Deterministic aero scene: a seeded upward-cone emitter over a TALL canvas (no
 * floor contact, so the air forces accumulate in free flight) for 90 frames.
 * Returns an order-dependent fingerprint over every live column each frame.
 */
function aeroScene(config) {
    const max = 128;
    const e = new SparkEngine(max, { rng: makeFloatRng(SEED), ...config });
    let h = 0x811c9dc5;
    for (let fr = 0; fr < 90; fr++) {
        if ((fr % 6) === 0) e.burst(400, 500, 10, -TAU / 2, 0, 60, 420, 0.4, 1.2);
        e.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
        for (let i = 0; i < max; i++) {
            h = mix(h, e.state[i]);
            if (e.state[i] !== 1) continue;
            h = mix(h, bits(e.x[i]));
            h = mix(h, bits(e.y[i]));
            h = mix(h, bits(e.vx[i]));
            h = mix(h, bits(e.vy[i]));
            h = mix(h, bits(e.life[i]));
        }
    }
    return h;
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

        // A burst larger than the pool can only ever fill the pool -> min(count,
        // max). The ring cursor overwrites the oldest slots (S-08); the ceiling
        // is the pool size, not the free count.
        e.burst(400, 300, 500, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e) === max,
            () => 'T0.conservation: burst over-capacity -> alive ' + aliveCount(e) + ' != ' + max + ' (seed=' + SEED + ')');

        // A burst into a full pool overwrites live slots -- count is unchanged.
        e.burst(400, 300, 1, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e) === max,
            () => 'T0.conservation: burst into a full pool changed count to ' + aliveCount(e) + ' (seed=' + SEED + ')');

        // count == max exactly on an empty pool -> fills every slot once.
        const e2 = new SparkEngine(64, { rng: makeFloatRng(SEED) });
        e2.burst(0, 0, 64, 0, Math.PI * 2, 100, 500);
        check(aliveCount(e2) === 64,
            () => 'T0.conservation: burst(count==max) -> alive ' + aliveCount(e2) + ' != 64 (seed=' + SEED + ')');
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

    // --- Law 4: S-04 dt-scaling ------------------------------------------
    // One `dt` step vs two `dt/2` steps must land within tolerance for a spark
    // in free flight (friction + gravity, no bounce -- a tall canvas keeps the
    // floor out of reach). With the pre-S-04 per-frame `v *= friction` this
    // diverged (the T9 control replays it); with `pow(friction, dt*60)` the
    // friction retention is identical across the two schedules and only the
    // Euler discretization of gravity remains, which is sub-pixel here.
    {
        const DT = 1 / 30;
        const POS_TOL = 1.0;   // px
        const VEL_TOL = 1.0;   // px/s
        const W = 800, H = 100000; // H huge so gravity never reaches the floor

        const seed = (e) => {
            e.state[0] = 1;
            e.x[0] = 400; e.y[0] = 500;
            e.vx[0] = 200; e.vy[0] = -100; // moving up-right, away from the floor
            e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
        };

        const big = new SparkEngine(4, { rng: () => 0.5 });
        const half = new SparkEngine(4, { rng: () => 0.5 });
        seed(big); seed(half);

        big.updateAndDraw(stubCtx, DT, W, H);
        half.updateAndDraw(stubCtx, DT / 2, W, H);
        half.updateAndDraw(stubCtx, DT / 2, W, H);

        check(Math.abs(big.x[0] - half.x[0]) <= POS_TOL,
            () => 'T0.dtScaling: x diverged ' + Math.abs(big.x[0] - half.x[0]) + ' > ' + POS_TOL);
        check(Math.abs(big.y[0] - half.y[0]) <= POS_TOL,
            () => 'T0.dtScaling: y diverged ' + Math.abs(big.y[0] - half.y[0]) + ' > ' + POS_TOL);
        check(Math.abs(big.vx[0] - half.vx[0]) <= VEL_TOL,
            () => 'T0.dtScaling: vx diverged ' + Math.abs(big.vx[0] - half.vx[0]) + ' > ' + VEL_TOL);
        check(Math.abs(big.vy[0] - half.vy[0]) <= VEL_TOL,
            () => 'T0.dtScaling: vy diverged ' + Math.abs(big.vy[0] - half.vy[0]) + ' > ' + VEL_TOL);
    }

    // --- Law 5: S-03 autoClear -------------------------------------------
    // A recording ctx counts clearRect calls. Default autoClear true clears once
    // per frame; autoClear:false must never clear, so a caller's pre-drawn pixels
    // survive between engine strokes. (One-shot assertion, not a measured loop --
    // allocating the recording ctx here is fine; the gate measures T6, not T0.)
    {
        let clears = 0;
        const recCtx = {
            clearRect() { clears++; }, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() {}, strokeStyle: '', lineWidth: 1, lineCap: 'butt',
            globalCompositeOperation: 'source-over',
        };

        const on = new SparkEngine(8, { rng: makeFloatRng(SEED) }); // autoClear default true
        on.burst(400, 300, 4, 0, Math.PI * 2, 100, 500);
        on.updateAndDraw(recCtx, 1 / 60, 800, 600);
        check(clears === 1,
            () => 'T0.autoClear: default did not call clearRect exactly once (got ' + clears + ')');

        clears = 0;
        const off = new SparkEngine(8, { rng: makeFloatRng(SEED), autoClear: false });
        off.burst(400, 300, 4, 0, Math.PI * 2, 100, 500);
        off.updateAndDraw(recCtx, 1 / 60, 800, 600);
        check(clears === 0,
            () => 'T0.autoClear: autoClear:false still called clearRect (' + clears + ')');
    }

    // --- Law 6: S-13 aero-off fingerprint == v1.2.0 (added v1.3.0) ----------
    // With every air knob 0, `aero` is false and the single hoisted `if (aero)`
    // is skipped, so the per-particle body is byte-identical to v1.2.0. The
    // committed fingerprint is therefore the v1.2.0 trajectory; any regression on
    // the default path moves it. Also proven structurally: an aero-off engine and
    // a v1.2.0-equivalent (default) engine are Object.is-identical, column by
    // column, over the same seeded 90-frame script.
    {
        const off = aeroScene({});
        if (SEED === 0x9e3779b9) {
            check(off === AERO_OFF_HASH,
                () => 'T0.aeroOff: default-path fingerprint moved -- got ' + off +
                      ' want ' + AERO_OFF_HASH + ' (S-13 leaked onto the aero-off body / physics regression)');
        }

        // Object.is-identity between two default engines run in lockstep. This is
        // the executable form of "aero-off === v1.2.0": the aero code changes
        // nothing when the knobs are 0. (A perturbed control lives in T9.)
        const max = 96;
        const a = new SparkEngine(max, { rng: makeFloatRng(SEED) });                 // aero-off
        const b = new SparkEngine(max, { rng: makeFloatRng(SEED), wind: 0, gust: 0, turbulence: 0 }); // explicit-zero
        for (let fr = 0; fr < 40; fr++) {
            if ((fr % 5) === 0) { a.burst(400, 300, 8, 0, TAU, 50, 400, 0.3, 0.9); b.burst(400, 300, 8, 0, TAU, 50, 400, 0.3, 0.9); }
            a.updateAndDraw(stubCtx, 1 / 60, 800, 600);
            b.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        }
        for (let i = 0; i < max; i++) {
            check(a.state[i] === b.state[i] &&
                  Object.is(a.x[i], b.x[i]) && Object.is(a.y[i], b.y[i]) &&
                  Object.is(a.vx[i], b.vx[i]) && Object.is(a.vy[i], b.vy[i]) &&
                  Object.is(a.life[i], b.life[i]),
                () => 'T0.aeroOff: explicit-zero knobs diverged from the default at slot ' + i +
                      ' -- the aero-off path is NOT byte-identical to v1.2.0 (seed=' + SEED + ')');
        }
    }

    // --- Law 7: S-13 wind -- committed hash + direction witness ------------
    // Wind is a constant +x push. The fingerprint pins the exact trajectory; the
    // witness proves the DIRECTION: the same seeded scene under wind ends with a
    // strictly greater mean live-x than aero-off. (friction 1 isolates the push.)
    {
        const wind = aeroScene({ wind: 300 });
        if (SEED === 0x9e3779b9) {
            check(wind === WIND_HASH,
                () => 'T0.wind: fingerprint moved -- got ' + wind + ' want ' + WIND_HASH);
        }
        check(wind !== AERO_OFF_HASH,
            () => 'T0.wind: wind=300 produced the aero-off fingerprint -- the wind term did nothing');

        // Direction: a single free-flight spark drifts +x under +wind, -x under
        // -wind, relative to no wind. friction 1 so only the push moves vx.
        const meanX = (w) => {
            const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, wind: w });
            e.state[0] = 1; e.x[0] = 400; e.y[0] = 500; e.vx[0] = 0; e.vy[0] = -100;
            e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
            for (let fr = 0; fr < 60; fr++) e.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            return e.x[0];
        };
        const x0 = meanX(0), xPlus = meanX(300), xMinus = meanX(-300);
        check(xPlus > x0 + 100,
            () => 'T0.wind: +wind did not push +x enough (dx=' + (xPlus - x0).toFixed(2) + ')');
        check(xMinus < x0 - 100,
            () => 'T0.wind: -wind did not push -x (dx=' + (xMinus - x0).toFixed(2) + ')');
    }

    // --- Law 8: S-13 gust -- committed hash + zero-mean witness ------------
    // Gust is a sin oscillation at GUST_HZ = TAU/3 (a 3-second period). Over one
    // full period the field integrates to zero. Witness: a free-flight spark
    // (gravity 0, friction 1, wind 0) accumulates vx = dt * sum(gustNow); after
    // exactly one period (180 frames at dt=1/60) that sum -- hence the field's
    // mean -- is within 1e-6*gust of zero.
    {
        const gust = aeroScene({ gust: 300 });
        if (SEED === 0x9e3779b9) {
            check(gust === GUST_HASH,
                () => 'T0.gust: fingerprint moved -- got ' + gust + ' want ' + GUST_HASH);
        }
        check(gust !== AERO_OFF_HASH,
            () => 'T0.gust: gust=300 produced the aero-off fingerprint -- the gust term did nothing');

        const G = 300, dt = 1 / 60, PERIOD = 180; // 3s / (1/60) = 180 frames
        const e = new SparkEngine(4, { rng: () => 0.5, gravity: 0, friction: 1, gust: G });
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 500; e.vx[0] = 0; e.vy[0] = 1e-3;
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
        for (let fr = 0; fr < PERIOD; fr++) e.updateAndDraw(stubCtx, dt, 800, 100000);
        // vx == dt * sum(gustNow); mean field = vx / (PERIOD*dt) = sum(gustNow)/PERIOD.
        const meanField = e.vx[0] / (PERIOD * dt);
        check(Math.abs(meanField) <= 1e-6 * G,
            () => 'T0.gust: field is not zero-mean over one period -- |mean|=' +
                  Math.abs(meanField) + ' > ' + (1e-6 * G));
    }

    // --- Law 9: S-13 turbulence -- committed hash + divergence witness -----
    // Turbulence phase is invLife[i]*TURB_K + elapsed, so two sparks with
    // distinct invLife wander in different directions. Witness: two free-flight
    // sparks with distinct invLife diverge > 0.5px by frame 30, and the run is
    // bit-deterministic across 3 reruns (no rng in the turbulence path).
    {
        const turb = aeroScene({ turbulence: 400 });
        if (SEED === 0x9e3779b9) {
            check(turb === TURB_HASH,
                () => 'T0.turb: fingerprint moved -- got ' + turb + ' want ' + TURB_HASH);
        }
        check(turb !== AERO_OFF_HASH,
            () => 'T0.turb: turbulence=400 produced the aero-off fingerprint -- the turbulence term did nothing');

        const mkPair = () => {
            const e = new SparkEngine(4, { rng: () => 0.5, gravity: 0, friction: 1, turbulence: 400 });
            // Two sparks, distinct life -> distinct invLife -> distinct phase.
            e.state[0] = 1; e.x[0] = 400; e.y[0] = 500; e.vx[0] = 0; e.vy[0] = 1e-3;
            e.life[0] = 0.5; e.invLife[0] = 1 / 0.5; e.weight[0] = 2;
            e.state[1] = 1; e.x[1] = 400; e.y[1] = 500; e.vx[1] = 0; e.vy[1] = 1e-3;
            e.life[1] = 1.0; e.invLife[1] = 1 / 1.0; e.weight[1] = 2;
            return e;
        };
        const e = mkPair();
        for (let fr = 0; fr < 30; fr++) e.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
        const sep = Math.hypot(e.x[0] - e.x[1], e.y[0] - e.y[1]);
        check(sep > 0.5,
            () => 'T0.turb: two distinct-invLife sparks stayed within ' + sep.toFixed(3) +
                  'px by frame 30 (they should wander apart)');

        // Bit-determinism across 3 reruns (Object.is on both sparks' columns).
        const snap = (eng) => [eng.x[0], eng.y[0], eng.vx[0], eng.vy[0], eng.x[1], eng.y[1], eng.vx[1], eng.vy[1]];
        const ref = snap(e);
        for (let r = 0; r < 2; r++) {
            const e2 = mkPair();
            for (let fr = 0; fr < 30; fr++) e2.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            const s2 = snap(e2);
            for (let k = 0; k < ref.length; k++) {
                check(Object.is(ref[k], s2[k]),
                    () => 'T0.turb: rerun ' + r + ' diverged at channel ' + k +
                          ' -- turbulence is not deterministic');
            }
        }
    }

    // --- Law 10: S-14 walls -- committed hash + contain/reflect witness -----
    // Walls are a position clamp with velocity reflection inside the moving gate.
    // The fingerprint pins the exact wall-reflected trajectory. The witness is
    // the load-bearing contrast: leftward sparks that WITHOUT a wall drift off the
    // left edge and X-cull to 0 alive are, WITH wallLeft, contained (8/8 alive,
    // x >= wallLeft) and their vx sign flipped -- the "aliveCount 8/8 where cull
    // left 0" property (ADR 0009).
    {
        const wall = aeroScene({ wallLeft: 200, wallRight: 600 });
        if (SEED === 0x9e3779b9) {
            check(wall === WALL_HASH,
                () => 'T0.wall: fingerprint moved -- got ' + wall + ' want ' + WALL_HASH);
        }
        check(wall !== AERO_OFF_HASH,
            () => 'T0.wall: walls produced the aero-off fingerprint -- the wall clamp did nothing');

        // 8 sparks driven hard left. friction 1 / gravity 0 isolate the drift.
        const seed8Left = (e) => {
            for (let i = 0; i < 8; i++) {
                e.state[i] = 1; e.x[i] = 400; e.y[i] = 500; e.vx[i] = -500; e.vy[i] = 1e-3;
                e.life[i] = 100; e.invLife[i] = 1 / 100; e.weight[i] = 2;
            }
        };
        // Without a wall: drift left, X-cull past cullMin (-200) -> pool drains to 0.
        const noWall = new SparkEngine(8, { rng: () => 0.5, friction: 1, gravity: 0 });
        seed8Left(noWall);
        for (let f = 0; f < 90; f++) noWall.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
        check(aliveCount(noWall) === 0,
            () => 'T0.wall: without a wall the leftbound sparks did NOT X-cull (alive ' +
                  aliveCount(noWall) + ' != 0) -- the contrast is vacuous');

        // With wallLeft: contained and reflected -- 8/8 alive, x >= wall, vx flipped.
        const WL = 100;
        const withWall = new SparkEngine(8, { rng: () => 0.5, friction: 1, gravity: 0, wallLeft: WL });
        seed8Left(withWall);
        let minX = Infinity, flipped = false;
        for (let f = 0; f < 60; f++) {
            withWall.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            for (let i = 0; i < 8; i++) {
                if (withWall.state[i] === 1 && withWall.x[i] < minX) minX = withWall.x[i];
                if (withWall.vx[i] > 0) flipped = true;
            }
        }
        check(aliveCount(withWall) === 8,
            () => 'T0.wall: wallLeft did not keep all 8 sparks alive (alive ' + aliveCount(withWall) + '/8)');
        check(minX >= WL - 1e-3,
            () => 'T0.wall: a spark escaped past wallLeft -- min x ' + minX + ' < ' + WL);
        check(flipped,
            () => 'T0.wall: no spark had its vx reflected to +x at the wall');
    }

    // --- Law 11: S-14 ceiling -- committed hash + contain/reflect witness ---
    // The ceiling reflects vy and contains y from above, inside the moving gate.
    // The fingerprint pins the exact contained trajectory. Witness: fast upward
    // sparks are held at y >= ceiling (8/8 alive), with vy reflected downward;
    // WITHOUT the ceiling the same sparks escape above the line (min y < ceiling),
    // proving the clamp is load-bearing (ADR 0009).
    {
        const ceil = aeroScene({ ceiling: 450 });
        if (SEED === 0x9e3779b9) {
            check(ceil === CEIL_HASH,
                () => 'T0.ceil: fingerprint moved -- got ' + ceil + ' want ' + CEIL_HASH);
        }
        check(ceil !== AERO_OFF_HASH,
            () => 'T0.ceil: ceiling produced the aero-off fingerprint -- the ceiling clamp did nothing');

        const seed8Up = (e) => {
            for (let i = 0; i < 8; i++) {
                e.state[i] = 1; e.x[i] = 400; e.y[i] = 500; e.vx[i] = 0; e.vy[i] = -800;
                e.life[i] = 100; e.invLife[i] = 1 / 100; e.weight[i] = 2;
            }
        };
        const CEIL = 0;
        // Without a ceiling: the sparks fly up past y=0 (escape above the line).
        const noCeil = new SparkEngine(8, { rng: () => 0.5, friction: 1, gravity: 0 });
        seed8Up(noCeil);
        let escMinY = Infinity;
        for (let f = 0; f < 60; f++) {
            noCeil.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            for (let i = 0; i < 8; i++) if (noCeil.state[i] === 1 && noCeil.y[i] < escMinY) escMinY = noCeil.y[i];
        }
        check(escMinY < CEIL,
            () => 'T0.ceil: without a ceiling the upward sparks stayed at y ' + escMinY +
                  ' >= ' + CEIL + ' -- the contrast is vacuous');

        // With the ceiling: contained (y >= ceiling), 8/8 alive, vy reflected down.
        const withCeil = new SparkEngine(8, { rng: () => 0.5, friction: 1, gravity: 0, ceiling: CEIL });
        seed8Up(withCeil);
        let minY = Infinity, flippedDown = false;
        for (let f = 0; f < 60; f++) {
            withCeil.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            for (let i = 0; i < 8; i++) {
                if (withCeil.state[i] === 1 && withCeil.y[i] < minY) minY = withCeil.y[i];
                if (withCeil.vy[i] > 0) flippedDown = true;
            }
        }
        check(aliveCount(withCeil) === 8,
            () => 'T0.ceil: ceiling did not keep all 8 sparks alive (alive ' + aliveCount(withCeil) + '/8)');
        check(minY >= CEIL - 1e-3,
            () => 'T0.ceil: a spark escaped above the ceiling -- min y ' + minY + ' < ' + CEIL);
        check(flippedDown,
            () => 'T0.ceil: no spark had its vy reflected to +y at the ceiling');
    }

    // --- Law 12: S-14 vortex attract -- committed hash + pull witness -------
    // attract pulls each moving spark radially toward (attractX, attractY). The
    // fingerprint pins the field. Witness: attract=+2000 cuts a spark's distance
    // to the center by > 50% (it passes through), and a HOSTILE attract=-1e9 stays
    // finite because each axis is clamped to +/-VORTEX_MAX_ACCEL (ADR 0010).
    {
        const vortex = aeroScene({ attract: 2000, attractX: 400, attractY: 500 });
        if (SEED === 0x9e3779b9) {
            check(vortex === VORTEX_HASH,
                () => 'T0.vortex: fingerprint moved -- got ' + vortex + ' want ' + VORTEX_HASH);
        }
        check(vortex !== AERO_OFF_HASH,
            () => 'T0.vortex: attract produced the aero-off fingerprint -- the vortex term did nothing');

        // A single spark 300px right of the center is pulled in. friction 1 /
        // gravity 0 isolate the radial pull; track the MIN distance over the run.
        const CX = 400, CY = 500, D0 = 300;
        const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: 2000, attractX: CX, attractY: CY });
        e.state[0] = 1; e.x[0] = CX + D0; e.y[0] = CY; e.vx[0] = 0; e.vy[0] = 1e-3;
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
        let minD = Infinity;
        for (let f = 0; f < 60; f++) {
            e.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            const d = Math.hypot(e.x[0] - CX, e.y[0] - CY);
            if (d < minD) minD = d;
        }
        check(minD < 0.5 * D0,
            () => 'T0.vortex: attract=+2000 did not cut distance by > 50% -- min dist ' +
                  minD.toFixed(2) + ' >= ' + (0.5 * D0));

        // Hostile attract: -1e9 repulsion. The per-axis clamp bounds |a| at 4000,
        // so velocity grows at most 4000*dt per frame and the pool stays finite.
        const hostile = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: -1e9, attractX: CX, attractY: CY });
        hostile.state[0] = 1; hostile.x[0] = CX + D0; hostile.y[0] = CY; hostile.vx[0] = 0; hostile.vy[0] = 1e-3;
        hostile.life[0] = 100; hostile.invLife[0] = 1 / 100; hostile.weight[0] = 2;
        for (let f = 0; f < 60; f++) hostile.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
        check(aliveFinite(hostile),
            () => 'T0.vortex: a hostile attract=-1e9 went non-finite -- the VORTEX_MAX_ACCEL clamp failed');
    }

    // --- Law 13: S-14 vortex swirl -- committed hash + tangential witness ---
    // swirl adds a push perpendicular to the radius: a spark on the +x side of the
    // center is nudged in y, not toward the center. The fingerprint pins the field.
    // Witness: a spark 300px right of the center moves off the x-axis (its y leaves
    // the center line) while attract=0 keeps it from collapsing inward, and the
    // run is bit-deterministic (no rng in the vortex path) (ADR 0010).
    {
        const swirl = aeroScene({ swirl: 2000, attractX: 400, attractY: 500 });
        if (SEED === 0x9e3779b9) {
            check(swirl === SWIRL_HASH,
                () => 'T0.swirl: fingerprint moved -- got ' + swirl + ' want ' + SWIRL_HASH);
        }
        check(swirl !== AERO_OFF_HASH,
            () => 'T0.swirl: swirl produced the aero-off fingerprint -- the swirl term did nothing');

        const CX = 400, CY = 500, D0 = 300;
        const mk = () => {
            const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, swirl: 2000, attractX: CX, attractY: CY });
            e.state[0] = 1; e.x[0] = CX + D0; e.y[0] = CY; e.vx[0] = 0; e.vy[0] = 1e-3;
            e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
            return e;
        };
        const e = mk();
        for (let f = 0; f < 30; f++) e.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
        check(Math.abs(e.y[0] - CY) > 1,
            () => 'T0.swirl: the spark did not move tangentially (|y - center| ' +
                  Math.abs(e.y[0] - CY).toFixed(3) + ' <= 1)');
        check(Math.hypot(e.x[0] - CX, e.y[0] - CY) > 1,
            () => 'T0.swirl: swirl collapsed the spark onto the center (attract should be 0)');

        // Bit-determinism across 3 reruns (no rng in the swirl path).
        const ref = [e.x[0], e.y[0], e.vx[0], e.vy[0]];
        for (let r = 0; r < 2; r++) {
            const e2 = mk();
            for (let f = 0; f < 30; f++) e2.updateAndDraw(stubCtx, 1 / 60, 800, 100000);
            const s2 = [e2.x[0], e2.y[0], e2.vx[0], e2.vy[0]];
            for (let k = 0; k < ref.length; k++) {
                check(Object.is(ref[k], s2[k]),
                    () => 'T0.swirl: rerun ' + r + ' diverged at channel ' + k + ' -- swirl is not deterministic');
            }
        }
    }
}
