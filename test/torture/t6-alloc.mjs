/**
 * T6 -- the zero-alloc gate (the core).
 *
 * One scene: a full pool under sustained emission + physics + render, measured
 * with lite-gc-profiler and gated at maxMajor:0 / maxPauseMs:4 /
 * maxArrayBuffersGrowth:0. The last rule is the one that matters here: the eight
 * SoA columns (x/y/vx/vy/life/invLife/weight/state) are ArrayBuffer backing
 * stores that live OUTSIDE the V8 heap and are invisible to a heapUsed gate.
 * `runOpsGate` supplies `stabilize:'deep'` so the rule is resolvable.
 *
 * A heap gate cannot substitute for a direct structural assertion either, so we
 * also pin all eight `buffer.byteLength` values across the window: nothing may
 * grow (the S-08 / batching regression tripwire).
 *
 * SPARKS_TORTURE_BREAK=1 injects a retained allocation into the hot body: the
 * gate must then reject the window. That is the T9 control, exercisable here.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { runOpsGate, BREAK, stubCtx, check, die } from './harness.mjs';

const TAU = Math.PI * 2;
const MAX = 2000;
const W = 800;
const H = 600;
const OPS = 20000;
const WARMUP = 2000;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

export function run() {
    const engine = new SparkEngine(MAX, { rng: () => 0.5 });

    // Fill the pool so the hot loop runs a full-pool physics + render pass and a
    // sustained burst into a mostly-occupied pool (the S-08 scan hot path).
    engine.burst(W / 2, H / 2, MAX, 0, TAU, 100, 800);

    const hot = (i) => {
        if ((i & 63) === 0) engine.burst(W / 2, H / 2, 16, 0, TAU, 100, 800);
        engine.updateAndDraw(stubCtx, 1 / 60, W, H);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };

    // Pin ALL EIGHT SoA backing stores before the window.
    const b = {
        x: engine.x.buffer.byteLength,
        y: engine.y.buffer.byteLength,
        vx: engine.vx.buffer.byteLength,
        vy: engine.vy.buffer.byteLength,
        life: engine.life.buffer.byteLength,
        invLife: engine.invLife.buffer.byteLength,
        weight: engine.weight.buffer.byteLength,
        state: engine.state.buffer.byteLength,
    };

    const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

    // Structural pins no heap gate can make: every SoA column byte-identical.
    check(engine.x.buffer.byteLength === b.x, () => 'T6: x SoA store grew ' + b.x + ' -> ' + engine.x.buffer.byteLength);
    check(engine.y.buffer.byteLength === b.y, () => 'T6: y SoA store grew ' + b.y + ' -> ' + engine.y.buffer.byteLength);
    check(engine.vx.buffer.byteLength === b.vx, () => 'T6: vx SoA store grew ' + b.vx + ' -> ' + engine.vx.buffer.byteLength);
    check(engine.vy.buffer.byteLength === b.vy, () => 'T6: vy SoA store grew ' + b.vy + ' -> ' + engine.vy.buffer.byteLength);
    check(engine.life.buffer.byteLength === b.life, () => 'T6: life SoA store grew ' + b.life + ' -> ' + engine.life.buffer.byteLength);
    check(engine.invLife.buffer.byteLength === b.invLife, () => 'T6: invLife SoA store grew ' + b.invLife + ' -> ' + engine.invLife.buffer.byteLength);
    check(engine.weight.buffer.byteLength === b.weight, () => 'T6: weight SoA store grew ' + b.weight + ' -> ' + engine.weight.buffer.byteLength);
    check(engine.state.buffer.byteLength === b.state, () => 'T6: state SoA store grew ' + b.state + ' -> ' + engine.state.buffer.byteLength);

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
}
