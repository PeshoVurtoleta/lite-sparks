/**
 * T6 -- the zero-alloc gate (the core).
 *
 * Scene A: a full pool under sustained emission + physics + batched render,
 * measured with lite-gc-profiler and gated at maxMajor:0 / maxPauseMs:4 /
 * maxArrayBuffersGrowth:0. The last rule is the one that matters here: the SoA
 * columns AND the S-07 counting-sort scratch are ArrayBuffer backing stores that
 * live OUTSIDE the V8 heap and are invisible to a heapUsed gate. `runOpsGate`
 * supplies `stabilize:'deep'` so the rule is resolvable.
 *
 * A heap gate cannot substitute for a direct structural assertion either, so we
 * also pin all TWELVE `buffer.byteLength` values across the window: the eight SoA
 * columns plus the four batching buffers (wBucket, _order, _binCount, _binStart).
 * Nothing may grow -- the S-07 / S-08 regression tripwire.
 *
 * Scene B: burst(max) into a FULL pool. The S-08 ring cursor must spawn exactly
 * `max` fresh sparks (overwrite-oldest), visiting <= 2*max slots, leaving the
 * pool full -- the O(count) spawn bound, proven structurally.
 *
 * SPARKS_TORTURE_BREAK=1 injects a retained allocation into scene A's hot body:
 * the gate must then reject the window. That is the T9 control, exercisable here.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { runOpsGate, BREAK, stubCtx, check, die, aliveCount } from './harness.mjs';

const TAU = Math.PI * 2;
const MAX = 2000;
const W = 800;
const H = 600;
const OPS = 20000;
const WARMUP = 2000;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

/** Snapshot the 12 backing-store byte lengths (8 SoA + 4 batching scratch). */
function snapshot(e) {
    return {
        x: e.x.buffer.byteLength, y: e.y.buffer.byteLength,
        vx: e.vx.buffer.byteLength, vy: e.vy.buffer.byteLength,
        life: e.life.buffer.byteLength, invLife: e.invLife.buffer.byteLength,
        weight: e.weight.buffer.byteLength, state: e.state.buffer.byteLength,
        wBucket: e.wBucket.buffer.byteLength, order: e._order.buffer.byteLength,
        binCount: e._binCount.buffer.byteLength, binStart: e._binStart.buffer.byteLength,
    };
}

export function run() {
    // ---- Scene A: full-pool sustained emission + physics + render ----------
    const engine = new SparkEngine(MAX, { rng: () => 0.5 });

    // Fill the pool so the hot loop runs a full-pool physics + render pass and a
    // sustained burst into a full pool (the S-08 ring-cursor hot path).
    engine.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);

    const hot = (i) => {
        if ((i & 63) === 0) engine.burst(W / 2, H / 2, 16, 0, TAU, 100, 800);
        engine.updateAndDraw(stubCtx, 1 / 60, W, H);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };

    // Pin ALL TWELVE backing stores before the window.
    const b = snapshot(engine);

    const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

    // Structural pins no heap gate can make: every backing store byte-identical.
    const a = snapshot(engine);
    check(a.x === b.x, () => 'T6: x SoA store grew ' + b.x + ' -> ' + a.x);
    check(a.y === b.y, () => 'T6: y SoA store grew ' + b.y + ' -> ' + a.y);
    check(a.vx === b.vx, () => 'T6: vx SoA store grew ' + b.vx + ' -> ' + a.vx);
    check(a.vy === b.vy, () => 'T6: vy SoA store grew ' + b.vy + ' -> ' + a.vy);
    check(a.life === b.life, () => 'T6: life SoA store grew ' + b.life + ' -> ' + a.life);
    check(a.invLife === b.invLife, () => 'T6: invLife SoA store grew ' + b.invLife + ' -> ' + a.invLife);
    check(a.weight === b.weight, () => 'T6: weight SoA store grew ' + b.weight + ' -> ' + a.weight);
    check(a.state === b.state, () => 'T6: state SoA store grew ' + b.state + ' -> ' + a.state);
    check(a.wBucket === b.wBucket, () => 'T6: wBucket store grew ' + b.wBucket + ' -> ' + a.wBucket);
    check(a.order === b.order, () => 'T6: _order store grew ' + b.order + ' -> ' + a.order);
    check(a.binCount === b.binCount, () => 'T6: _binCount store grew ' + b.binCount + ' -> ' + a.binCount);
    check(a.binStart === b.binStart, () => 'T6: _binStart store grew ' + b.binStart + ' -> ' + a.binStart);

    if (!report.ok) {
        const g = summary.gc;
        die('T6 alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            (BREAK ? ' (SPARKS_TORTURE_BREAK control -- expected)' : ''));
    }

    // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
    // control silently passed, which is itself a failure.
    if (BREAK) die('T6: SPARKS_TORTURE_BREAK injected allocations but the gate passed');

    // ---- Scene B: ring cursor -- burst(max) into a FULL pool ---------------
    // A separate engine, filled to capacity, then burst(max) again. The S-08 ring
    // cursor must spawn exactly `max` fresh sparks (overwrite-oldest) touching
    // <= 2*max slots (in fact exactly `max` -- one visit per spawn), leaving the
    // pool still full. This is the O(count) spawn bound as a structural pin.
    const ring = new SparkEngine(MAX, { rng: () => 0.5 });
    ring.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);
    check(aliveCount(ring) === MAX,
        () => 'T6.B: initial fill left ' + aliveCount(ring) + ' alive != ' + MAX);

    ring.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);
    check(ring._visits === MAX,
        () => 'T6.B: burst(max) into a full pool visited ' + ring._visits + ' slots (want exactly ' + MAX + ')');
    check(ring._visits <= 2 * MAX,
        () => 'T6.B: ring cursor visited ' + ring._visits + ' > ' + (2 * MAX) + ' slots -- not O(count)');
    check(aliveCount(ring) === MAX,
        () => 'T6.B: burst into full pool left ' + aliveCount(ring) + ' alive != ' + MAX);

    // ---- Scene C: S-13 aero lanes -- the air forces allocate nothing --------
    // Four lanes exercise the hot `if (aero)` branch under a full pool: wind,
    // gust, turbulence, and all-on. Each runs the same measured window and pins
    // all TWELVE backing-store byte lengths byte-identical -- the air feature
    // grows no buffer and the gate rejects a major GC / >4ms pause (ADR 0008).
    aeroLane('wind', { wind: 300 });
    aeroLane('gust', { gust: 300 });
    aeroLane('turb', { turbulence: 400 });
    aeroLane('all', { wind: 300, gust: 300, turbulence: 400 });

    // ---- Scene D: S-14 containment lanes -- walls + vortex allocate nothing --
    // The wall clamp (hot `if (walls)`) and the vortex accel (folded into the
    // `if (aero)` branch) run under a full pool with the bounds/center inside the
    // canvas so the branches are actually taken every frame. Each lane pins all
    // TWELVE backing stores byte-identical and gates a major GC / >4ms pause: the
    // containment feature grows no buffer and allocates nothing (ADR 0009/0010).
    aeroLane('walls', { wallLeft: 100, wallRight: 700, ceiling: 50 });
    aeroLane('vortex', { attract: 2000, swirl: 500, attractX: W / 2, attractY: H / 2 });
    aeroLane('containment-all', {
        wallLeft: 100, wallRight: 700, ceiling: 50,
        attract: 2000, swirl: 500, attractX: W / 2, attractY: H / 2,
    });
}

/**
 * One aero lane: a full pool under sustained emission + physics + render with
 * an air config on, measured and gated, all 12 backing stores pinned unchanged.
 */
function aeroLane(name, config) {
    const engine = new SparkEngine(MAX, { rng: () => 0.5, ...config });
    engine.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);

    const hot = (i) => {
        if ((i & 63) === 0) engine.burst(W / 2, H / 2, 16, 0, TAU, 100, 800);
        engine.updateAndDraw(stubCtx, 1 / 60, W, H);
    };

    const b = snapshot(engine);
    const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });
    const a = snapshot(engine);

    check(a.x === b.x, () => 'T6.aero[' + name + ']: x SoA store grew ' + b.x + ' -> ' + a.x);
    check(a.y === b.y, () => 'T6.aero[' + name + ']: y SoA store grew ' + b.y + ' -> ' + a.y);
    check(a.vx === b.vx, () => 'T6.aero[' + name + ']: vx SoA store grew ' + b.vx + ' -> ' + a.vx);
    check(a.vy === b.vy, () => 'T6.aero[' + name + ']: vy SoA store grew ' + b.vy + ' -> ' + a.vy);
    check(a.life === b.life, () => 'T6.aero[' + name + ']: life SoA store grew ' + b.life + ' -> ' + a.life);
    check(a.invLife === b.invLife, () => 'T6.aero[' + name + ']: invLife SoA store grew ' + b.invLife + ' -> ' + a.invLife);
    check(a.weight === b.weight, () => 'T6.aero[' + name + ']: weight SoA store grew ' + b.weight + ' -> ' + a.weight);
    check(a.state === b.state, () => 'T6.aero[' + name + ']: state SoA store grew ' + b.state + ' -> ' + a.state);
    check(a.wBucket === b.wBucket, () => 'T6.aero[' + name + ']: wBucket store grew ' + b.wBucket + ' -> ' + a.wBucket);
    check(a.order === b.order, () => 'T6.aero[' + name + ']: _order store grew ' + b.order + ' -> ' + a.order);
    check(a.binCount === b.binCount, () => 'T6.aero[' + name + ']: _binCount store grew ' + b.binCount + ' -> ' + a.binCount);
    check(a.binStart === b.binStart, () => 'T6.aero[' + name + ']: _binStart store grew ' + b.binStart + ' -> ' + a.binStart);

    if (!report.ok) {
        const g = summary.gc;
        die('T6.aero[' + name + '] alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
}
