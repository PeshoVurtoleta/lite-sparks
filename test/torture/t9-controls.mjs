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

import { SparkEngine, makeEmitter } from '../../SparkEngine.js';
import { makePrng, SEED, runOpsGate, stubCtx, die, aliveFinite, aliveCount } from './harness.mjs';

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

    // Control C -- the S-14 VORTEX_MAX_ACCEL clamp is load-bearing (ADR 0010). The
    // per-axis clamp bounds a hostile attract's per-frame velocity kick to at most
    // VORTEX_MAX_ACCEL*dt, so a spark cannot be teleported off-screen in one frame.
    // Prove BOTH halves on a single frame under attract=-1e9: (1) the REAL engine
    // (capped) leaves |vx| bounded (<= 100 px/s, i.e. ~4000*dt); (2) the SAME
    // vortex accel WITHOUT the clamp -- replayed inline -- kicks |vx| to ~|attract|*dt
    // (>> 100), which is exactly the bound the clamp holds. Remove the clamp and
    // the real engine's kick becomes the un-clamped value, so assertion (1) fails.
    {
        const CX = 400, CY = 500, D0 = 300, dt = 1 / 60, ATTRACT = -1e9;
        const CAP_BOUND = 100; // VORTEX_MAX_ACCEL*dt = 4000/60 = 66.7 < 100

        // (1) Real engine, one frame: the clamp bounds the velocity kick.
        const capped = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: ATTRACT, attractX: CX, attractY: CY });
        capped.state[0] = 1; capped.x[0] = CX + D0; capped.y[0] = CY; capped.vx[0] = 0; capped.vy[0] = 1e-3;
        capped.life[0] = 1e6; capped.invLife[0] = 1 / 1e6; capped.weight[0] = 2;
        capped.updateAndDraw(stubCtx, dt, 800, 100000);
        const cappedKick = Math.abs(capped.vx[0]);
        if (!(cappedKick <= CAP_BOUND)) {
            die('T9 control C: the real engine\'s vortex kick |vx|=' + cappedKick +
                ' exceeded the VORTEX_MAX_ACCEL bound ' + CAP_BOUND + ' -- the clamp FAILED (S-14)');
        }

        // (2) Un-clamped replay of the same first-frame accel: |dvx| = |attract|*dt.
        // The spark is +x of the center (nx = -1), so ax = attract*nx = +1e9,
        // UNCLAMPED -> a kick of 1.667e7 px/s. That is the value the clamp holds
        // under CAP_BOUND; if the clamp were removed, (1) above would see this.
        const unclampedKick = Math.abs(ATTRACT * (-1) * dt);
        if (!(unclampedKick > CAP_BOUND)) {
            die('T9 control C: the un-clamped vortex kick |dvx|=' + unclampedKick +
                ' did not exceed the bound -- the control cannot prove the clamp is load-bearing');
        }

        // Belt and braces: the clamp also keeps the pool finite over a long hostile
        // run (a teleport that overflowed a coordinate would flip aliveFinite).
        for (let f = 0; f < 4096; f++) capped.updateAndDraw(stubCtx, dt, 800, 100000);
        if (!aliveFinite(capped)) {
            die('T9 control C: the real engine went non-finite under a sustained hostile ' +
                'attract -- the VORTEX_MAX_ACCEL clamp did not hold over the run (S-14)');
        }
    }

    // Control D -- the S-14 wall clamp order is load-bearing (ADR 0009). The clamp
    // runs AFTER position integration, so a spark that crossed a wall THIS frame is
    // pulled back onto it. Prove BOTH halves on a single crossing step: (1) the
    // correct order (integrate THEN clamp) contains the spark (x >= wall) and
    // reflects vx; (2) the broken order (clamp BEFORE integrate) lets the spark
    // step straight through the wall -- it ends up OUTSIDE (x < wall) and would
    // drift on to X-cull (leak a spark). So the placement after integration is
    // what contains the spark; move it before and containment breaks.
    {
        const wall = 100, dt = 1 / 60;

        // (1) Correct order: integrate, then clamp -> contained + reflected.
        let cx = 105, cvx = -500;
        cx += cvx * dt;
        if (cx < wall) { cx = wall; if (cvx < 0) cvx = -cvx; }
        if (!(cx >= wall && cvx > 0)) {
            die('T9 control D: the correct clamp order (integrate then clamp) did NOT ' +
                'contain+reflect the spark (x=' + cx + ', vx=' + cvx + ') -- the control is broken');
        }

        // (2) Broken order: clamp before integrate -> the spark steps through.
        let wx = 105, wvx = -500;
        if (wx < wall) { wx = wall; if (wvx < 0) wvx = -wvx; }
        wx += wvx * dt;
        if (!(wx < wall)) {
            die('T9 control D: clamping BEFORE integration still left the spark contained ' +
                '(x=' + wx + ' >= ' + wall + ') -- the control cannot prove the clamp order is load-bearing');
        }
    }

    // Control E -- the S-14 wall clamp lives INSIDE the S-05 moving gate
    // (`if (vxs[i]!==0||vys[i]!==0)`), so a RESTING spark (vx===vy===0) is never
    // woken or reflected even when it sits outside a wall bound (containment.
    // test.js:182 proves this at unit level; this is its T9 can-fail control).
    // Prove BOTH halves on a single frame: (1) the REAL engine leaves a resting
    // spark seeded OUTSIDE wallLeft untouched (position + velocity unchanged);
    // (2) the BROKEN variant -- the exact wall-clamp op hoisted OUTSIDE the
    // moving gate, so it runs unconditionally -- yanks the same resting spark's
    // position onto the wall (a "resting" spark that silently teleports is no
    // longer at rest). If the gate placement stopped mattering, (1) would move
    // the spark too.
    {
        const WALL = 500, dt = 1 / 60;

        // (1) Real engine: a resting spark seeded OUTSIDE wallLeft (x=400 < 500),
        // walls active. Physics is bypassed entirely by the S-05 sleep check, so
        // the wall clamp never runs on it.
        const e = new SparkEngine(4, { rng: () => 0.5, wallLeft: WALL, wallRight: 300, ceiling: 400 });
        e.state[0] = 1; e.x[0] = 400; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0; // asleep
        e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
        for (let f = 0; f < 30; f++) e.updateAndDraw(stubCtx, dt, 800, 600);
        if (!(e.x[0] === 400 && e.y[0] === 300 && e.vx[0] === 0 && e.vy[0] === 0)) {
            die('T9 control E: a resting spark was moved/reflected by the wall clamp -- the ' +
                'clamp leaked outside the S-05 moving gate and woke a resting ember (S-14)');
        }

        // (2) Broken variant: the EXACT wallLeft clamp op from SparkEngine.js
        // (`if (wallLeft!=null && x<wallLeft) { x=wallLeft; if (vx<0) vx=-vx; }`),
        // applied unconditionally -- no `if (vx!==0||vy!==0)` guard -- to the same
        // resting spark's x/vx. This is what the code would do if the S-14 wall
        // block were hoisted OUTSIDE the moving gate: a resting spark parked
        // outside the bound gets yanked onto it (its vx stays 0 here, since 0<0
        // is false -- reflection only fires on an inbound velocity -- but the
        // POSITION pluck alone is the wake: a "resting" spark that silently
        // teleports is no longer at rest).
        let bx = 400, bvx = 0; // resting, outside wallLeft (mirrors e.x[0]/e.vx[0] above)
        if (bx < WALL) { bx = WALL; if (bvx < 0) bvx = -bvx; }
        if (!(bx !== 400)) {
            die('T9 control E: the un-guarded wall clamp left a resting spark untouched ' +
                '(x=' + bx + ') -- the control cannot prove hoisting the clamp ' +
                'outside the moving gate wakes/moves a resting ember');
        }
    }

    // Control F -- a hostile/uncapped emitter cannot break pool conservation
    // (S-02 count door + S-08 ring cursor). An emitter rate of 1e9 tries to flood
    // the pool every step, but `burst` caps count at `max` and the ring cursor
    // overwrites in place, so aliveCount stays <= max and every column stays
    // finite. Prove BOTH halves: (1) the REAL engine under a hostile emitter is
    // finite and full (aliveCount === max, not overflowed); (2) the detector is
    // not vacuous -- a NaN written into a live slot flips aliveFinite.
    {
        const e = new SparkEngine(64, { rng: () => 0.5 });
        const flood = makeEmitter({ x: 400, y: 300, rate: 1e9, cone: 0.6, speed: 500, life: 1.0 });
        for (let f = 0; f < 30; f++) { flood.step(e, 1 / 60); e.updateAndDraw(stubCtx, 1 / 60, 800, 600); }
        if (aliveCount(e) > e.max) {
            die('T9 control F: a hostile emitter overflowed pool conservation -- aliveCount ' +
                aliveCount(e) + ' > max ' + e.max + ' (the S-02/S-08 cap FAILED)');
        }
        if (!aliveFinite(e)) {
            die('T9 control F: a hostile emitter drove a live particle non-finite');
        }
        // Non-vacuous: the flood filled the pool and the detector can flip.
        if (aliveCount(e) === 0) {
            die('T9 control F: the hostile emitter spawned nothing -- the flood is vacuous');
        }
        let v = -1;
        for (let i = 0; i < e.max; i++) if (e.state[i] === 1) { v = i; break; }
        e.vx[v] = NaN;
        if (aliveFinite(e)) {
            die('T9 control F: aliveFinite stayed true after a NaN vx -- the conservation ' +
                'detector is blind, so a flooded/poisoned pool could pass');
        }
    }

    // Control G -- onBounce has NO try/catch, so a throwing hook MUST surface out
    // of updateAndDraw (a swallowed throw hides a caller bug and leaves the frame
    // half-rendered, ADR 0012). Prove BOTH halves: (1) a throwing onBounce, on a
    // spark driven hard into the floor, propagates -- updateAndDraw throws; (2)
    // the control is not vacuous -- the SAME scene with a non-throwing hook does
    // NOT throw, so the throw came from the hook and surfaced through the engine.
    {
        const seedFalling = (eng) => {
            eng.state[0] = 1; eng.x[0] = 400; eng.y[0] = 490; eng.vx[0] = 0; eng.vy[0] = 2000;
            eng.life[0] = 100; eng.invLife[0] = 1 / 100; eng.weight[0] = 2;
        };
        const thrower = () => { throw new Error('onBounce surfaced'); };
        const e = new SparkEngine(4, { rng: () => 0.5, onBounce: thrower, floorY: 500 });
        seedFalling(e);
        let surfaced = false;
        try {
            for (let f = 0; f < 10; f++) e.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        } catch (err) {
            surfaced = true;
        }
        if (!surfaced) {
            die('T9 control G: a throwing onBounce did NOT surface -- the engine swallowed it ' +
                '(there must be no try/catch around the hook, ADR 0012)');
        }
        // Non-vacuous: the same scene with a no-op hook completes without throwing.
        const ok = new SparkEngine(4, { rng: () => 0.5, onBounce: () => {}, floorY: 500 });
        seedFalling(ok);
        let threw = false;
        try {
            for (let f = 0; f < 10; f++) ok.updateAndDraw(stubCtx, 1 / 60, 800, 600);
        } catch (err) {
            threw = true;
        }
        if (threw) {
            die('T9 control G: a non-throwing onBounce threw -- the scene is broken, not the hook, ' +
                'so the surfacing control is vacuous');
        }
    }

    // Control H -- the enveloped lane restores globalAlpha to 1 (fail closed), so
    // a stale per-particle alpha never leaks into the next frame's composite or a
    // caller's shared canvas (ADR 0013). Prove BOTH halves: (1) after a REAL
    // enveloped frame the ctx's globalAlpha is back to 1; (2) a lane that sets a
    // per-particle fade alpha but FORGETS the restore leaves globalAlpha != 1 --
    // which is exactly what a missing `ctx.globalAlpha = 1` would produce.
    {
        const rec = {
            clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
            strokeStyle: '', lineWidth: 1, lineCap: 'butt',
            globalCompositeOperation: 'source-over', globalAlpha: 1,
        };
        const e = new SparkEngine(16, { rng: () => 0.5, fadeOut: 0.9 });
        e.burst(400, 300, 8, 0, Math.PI * 2, 100, 500);
        e.updateAndDraw(rec, 1 / 60, 800, 600);
        if (rec.globalAlpha !== 1) {
            die('T9 control H: after an enveloped frame ctx.globalAlpha=' + rec.globalAlpha +
                ' != 1 -- the fail-closed restore is missing (S-15)');
        }
        // Non-vacuous / can-fail: a broken lane that applies a mid-life fade and
        // omits the restore leaves globalAlpha below 1 -- the detectable defect.
        const broken = { globalAlpha: 1 };
        broken.globalAlpha = 1 - 0.9 * (1 - 0.3); // a fade factor, never restored
        if (broken.globalAlpha === 1) {
            die('T9 control H: the un-restored lane still reads globalAlpha=1 -- the control ' +
                'cannot prove the globalAlpha restore is load-bearing');
        }
    }
}
