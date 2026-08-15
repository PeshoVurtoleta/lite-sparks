/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * Each control runs a deliberately-broken variant IN PROCESS and asserts the
 * corresponding gate flags it. If a control slips through, T9 itself `die()`s --
 * a gate that cannot fail is decorative.
 *
 * There is also the whole-suite control: `SPARKS_TORTURE_BREAK=1 node
 * --expose-gc test/torture.mjs` injects retained allocations into the T6 hot
 * loop, so the alloc gate rejects and the process exits non-zero. T9 exercises
 * the same alloc lane here so a plain run already proves the gate bites.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { makePrng, SEED, runOpsGate, stubCtx, die, aliveFinite } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

function makeFloatRng(seed) {
    const prng = makePrng(seed);
    return () => prng() / 4294967296;
}

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0).
    const { report } = runOpsGate((i) => { leak.push(new Float64Array(64)); }, {
        ops: 4000,
        warmup: 0,
    });
    if (report.ok) {
        die('T9 control: an allocating hot loop passed the zero-alloc gate');
    }
    leak.length = 0; // release the control's garbage

    // Control 2 -- the S-01 poison detector. Write NaN straight into a live
    // particle's vy and confirm `aliveFinite` flips false. Prove it is not
    // vacuous: the same engine reads finite before the poison.
    const e = new SparkEngine(64, { rng: () => 0.5 });
    e.burst(400, 300, 8, 0, Math.PI * 2, 100, 500);
    if (!aliveFinite(e)) {
        die('T9 control: aliveFinite false on a healthy burst -- detector is broken');
    }
    // Find a live slot and poison it.
    let victim = -1;
    for (let i = 0; i < e.max; i++) if (e.state[i] === 1) { victim = i; break; }
    if (victim === -1) die('T9 control: burst produced no live particle to poison');
    e.vy[victim] = NaN;
    if (aliveFinite(e)) {
        die('T9 control: aliveFinite stayed true after a NaN vy -- the S-01 detector is blind');
    }

    // Control 2b -- the dt door is load-bearing (S-01). Prove that WITHOUT the
    // door a NaN dt poisons the engine, so `aliveFinite` catches it -- i.e. the
    // door, not luck, is the protection. First confirm the real door holds: a
    // NaN-dt frame through the public API is a no-op and leaves the engine
    // finite. Then replay the exact first physics op the loop would run with an
    // un-guarded NaN dt (`vy += gravity * dt`) and confirm it goes non-finite.
    const d = new SparkEngine(64, { rng: () => 0.5 });
    d.burst(400, 300, 8, 0, Math.PI * 2, 100, 500);
    d.updateAndDraw(stubCtx, NaN, 800, 600); // door returns -> no-op
    if (!aliveFinite(d)) {
        die('T9 control: the dt door FAILED -- a NaN-dt frame poisoned the engine ' +
            'through the public API (S-01 regression)');
    }
    let dv = -1;
    for (let i = 0; i < d.max; i++) if (d.state[i] === 1) { dv = i; break; }
    if (dv === -1) die('T9 control: burst produced no live particle for the dt-door control');
    // The un-guarded physics step (what the loop does when `!(dt>0)` does NOT
    // return): dt is NaN, so vy += gravity*NaN -> NaN.
    d.vy[dv] += d.config.gravity * NaN;
    if (aliveFinite(d)) {
        die('T9 control: an un-guarded NaN-dt physics step stayed finite -- ' +
            'aliveFinite cannot detect the S-01 poison the dt door prevents');
    }

    // Control 3 -- the determinism comparator. Two engines fed the same seed run
    // an identical script and MUST agree; perturbing one seeded draw MUST make
    // the snapshot diverge. If it does not, the T0 determinism law cannot fail.
    const a = new SparkEngine(64, { rng: makeFloatRng(SEED) });
    const bRng = makeFloatRng(SEED);
    bRng(); // perturbation: consume one extra draw so the streams differ
    const b = new SparkEngine(64, { rng: bRng });
    const script = (eng) => {
        for (let f = 0; f < 12; f++) {
            if ((f % 4) === 0) eng.burst(400, 100, 6, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
            eng.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        }
    };
    script(a); script(b);
    let diverged = false;
    for (let i = 0; i < 64; i++) {
        if (!Object.is(a.x[i], b.x[i]) || a.state[i] !== b.state[i]) { diverged = true; break; }
    }
    if (!diverged) {
        die('T9 control: a perturbed seeded draw produced an identical snapshot -- ' +
            'the determinism comparator cannot detect divergence');
    }

    // Sanity: two UNperturbed streams DO agree (so control 3 is not vacuous).
    const c1 = new SparkEngine(64, { rng: makeFloatRng(SEED) });
    const c2 = new SparkEngine(64, { rng: makeFloatRng(SEED) });
    script(c1); script(c2);
    for (let i = 0; i < 64; i++) {
        if (!Object.is(c1.x[i], c2.x[i]) || c1.state[i] !== c2.state[i]) {
            die('T9 control: two identical seeded streams diverged -- determinism is broken');
        }
    }

    // Control 4 -- the S-04 dt-scaling law (T0 law 4) must be able to FAIL. Replay
    // the PRE-S-04 free-flight physics, whose friction is the dt-independent
    // per-frame `v *= friction` the fix removed, and confirm one `dt` step and
    // two `dt/2` steps diverge beyond the same tolerance the T0 law enforces. If
    // the old model stayed within tolerance the dt-scaling law would be
    // decorative. (This mirrors the dt-door control above, which replays the
    // un-guarded `vy += gravity * NaN` op rather than patching updateAndDraw.)
    {
        const DT = 1 / 30;
        const POS_TOL = 1.0;
        const VEL_TOL = 1.0;
        const GRAV = 800, FRICTION = 0.99;

        // Exactly the v1.0.2 free-flight loop body, but with the pre-S-04
        // frame-rate-dependent friction: `v *= FRICTION` once per frame,
        // independent of dt. No bounce (the T0 law flies far above any floor).
        const oldStep = (s, dt) => {
            s.vy += GRAV * dt;
            s.vx *= FRICTION;
            s.vy *= FRICTION;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
        };

        const mk = () => ({ x: 400, y: 500, vx: 200, vy: -100 });
        const big = mk();
        const half = mk();
        oldStep(big, DT);
        oldStep(half, DT / 2);
        oldStep(half, DT / 2);

        const withinTol =
            Math.abs(big.x - half.x) <= POS_TOL &&
            Math.abs(big.y - half.y) <= POS_TOL &&
            Math.abs(big.vx - half.vx) <= VEL_TOL &&
            Math.abs(big.vy - half.vy) <= VEL_TOL;
        if (withinTol) {
            die('T9 control: the pre-S-04 per-frame `*= friction` model stayed within ' +
                'the dt-scaling tolerance -- the S-04 law (T0 law 4) cannot fail');
        }
    }

    // Control A -- the S-13 aero-off gate (T0 law 6) must be able to FAIL. If the
    // air force leaked onto the aero-off path (a broken `if (aero)` gate) the
    // default trajectory would change and law 6's committed AERO_OFF fingerprint
    // would move. Prove the comparator is not vacuous: an aero-off run and a run
    // with a tiny LEAKED wind MUST diverge; two aero-off runs MUST agree.
    {
        const script = (eng) => {
            for (let f = 0; f < 40; f++) {
                if ((f % 5) === 0) eng.burst(400, 300, 8, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
                eng.updateAndDraw(stubCtx, 1 / 60, 800, 100000); // tall: free flight
            }
        };
        const off = new SparkEngine(64, { rng: makeFloatRng(SEED) });
        const leak2 = new SparkEngine(64, { rng: makeFloatRng(SEED), wind: 1e-3 }); // gate leak
        script(off); script(leak2);
        let diverged = false;
        for (let i = 0; i < 64; i++) {
            if (off.state[i] === 1 && !Object.is(off.x[i], leak2.x[i])) { diverged = true; break; }
        }
        if (!diverged) {
            die('T9 control A: a leaked wind on the aero-off path produced an identical ' +
                'trajectory -- the AERO_OFF fingerprint (T0 law 6) cannot detect an aero gate leak');
        }
        // Non-vacuous: two aero-off runs DO agree byte-for-byte.
        const c1 = new SparkEngine(64, { rng: makeFloatRng(SEED) });
        const c2 = new SparkEngine(64, { rng: makeFloatRng(SEED) });
        script(c1); script(c2);
        for (let i = 0; i < 64; i++) {
            if (!Object.is(c1.x[i], c2.x[i]) || c1.state[i] !== c2.state[i]) {
                die('T9 control A: two aero-off runs diverged -- the aero-off path is not deterministic');
            }
        }
    }

    // Control B -- the S-13 "wind wakes resting embers" hazard (REJECTED, ADR
    // 0008). The aero force lives INSIDE the moving block, guarded by the S-05
    // sleep check, so a RESTING spark (vx==vy==0) never feels the wind. Prove
    // BOTH halves: (1) in the real engine a resting spark under strong wind stays
    // put; (2) the broken variant -- the same aero op applied OUTSIDE the moving
    // block -- DOES wake it, so the placement inside the block is load-bearing.
    {
        // (1) Real engine: a hand-seeded resting spark, strong wind, many frames.
        const e = new SparkEngine(4, { rng: () => 0.5, wind: 300, gust: 300, turbulence: 400 });
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0; // asleep
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
        const x0 = e.x[0];
        for (let f = 0; f < 30; f++) e.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        if (!(e.vx[0] === 0 && e.vy[0] === 0 && e.x[0] === x0)) {
            die('T9 control B: a resting spark was moved by the air forces -- aero leaked ' +
                'outside the S-05 moving block and woke a resting ember (ADR 0008 REJECTED case)');
        }

        // (2) Broken variant: the aero op applied OUTSIDE the moving block (no
        // sleep guard). A resting vx=0 is nudged to non-zero -- it would wake.
        const wind = 300, gustNow = Math.sin(0.5 * (Math.PI * 2 / 3)) * 300, dt = 1 / 60;
        let vx = 0; // a resting spark
        vx += (wind + gustNow) * dt; // unguarded aero: what a mis-placed block does
        if (vx === 0) {
            die('T9 control B: the un-guarded aero op left a resting vx at 0 -- the control ' +
                'cannot prove that lifting aero outside the moving block wakes a resting spark');
        }
    }
}
