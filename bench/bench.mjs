// bench/bench.mjs -- node --expose-gc bench/bench.mjs
//
// Honest engine-CPU micro-bench for @zakkster/lite-sparks. NOT shipped (not in
// package.json files[], same policy as test/). Every number the README/llms
// quotes comes from a run of THIS file -- no rounding to a nicer figure, no
// invention. Methodology: discard a warmup window, then take N reps and report
// the MEDIAN plus the min, using performance.now().
//
// The ctx is a no-op stub (every method () => {}), so we measure the engine's
// physics + counting-sort + path-issuing CPU, NOT canvas rasterization. These
// are engine-only numbers; a real 2D context's stroke()/clearRect cost is not
// included. Say so wherever these numbers are quoted.

import os from 'node:os';
import { SparkEngine, makeEmitter } from '../SparkEngine.js';

// ---- no-op stub ctx: measures the engine, not the rasterizer ---------------
const ctx = {
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    lineCap: '',
    lineWidth: 0,
    strokeStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: '',
};

const W = 1920, H = 1080;
const DT = 1 / 60;
const POOL = 5000;

function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Run `fn` REPS times after WARM discarded warmups; return {median, min} in ms.
function timeLane(fn, WARM, REPS) {
    for (let i = 0; i < WARM; i++) fn(i);
    const samples = new Float64Array(REPS);
    for (let i = 0; i < REPS; i++) {
        const t0 = performance.now();
        fn(i);
        samples[i] = performance.now() - t0;
    }
    const arr = Array.from(samples);
    let min = samples[0];
    for (let i = 1; i < samples.length; i++) if (samples[i] < min) min = samples[i];
    return { median: median(arr), min };
}

// ---- Lane A: burst throughput (sparks spawned per second) ------------------
// One representative impact burst (300 sparks, full radial) per rep. We measure
// only burst() -- the spawn ring, cone/speed/life draws, wBucket quantization.
const BURST_N = 300;
const engA = new SparkEngine(POOL);
const laneA = timeLane(() => {
    engA.burst(960, 540, BURST_N, 0, Math.PI * 2, 150, 800, 0.2, 0.7);
}, 2000, 20000);
const burstsPerSec = 1000 / laneA.median;
const sparksPerSec = burstsPerSec * BURST_N;

// ---- Lane B: full-frame physics + render for a FULL pool (5000 alive) ------
// Prime the pool so ~all POOL slots are alive, then measure one updateAndDraw
// per rep at 1/60 dt. gravity=0 and a huge life keep the pool saturated across
// the timed window so every rep does full-pool work (not a decaying count).
const engB = new SparkEngine(POOL, { gravity: 0, floorY: 1e9 });
// Fill the pool: bursts of POOL sparks, long life, wide spread, low speed so
// nothing culls off the 1920px stage during the measured window.
for (let k = 0; k < 3; k++) {
    engB.burst(960, 540, POOL, 0, Math.PI * 2, 0, 40, 1e6, 1e6);
}
const laneB = timeLane(() => {
    engB.updateAndDraw(ctx, DT, W, H);
}, 2000, 20000);
const alignedB = (() => {
    // Count how many are actually alive so the per-frame number is honest.
    let n = 0;
    for (let i = 0; i < engB.state.length; i++) if (engB.state[i] !== 0) n++;
    return n;
})();

// ---- Lane C: sustained emission (emit + full frame every rep) --------------
// A fractional-carry emitter emitting ~15 sparks/frame into a live pool, then a
// full updateAndDraw -- the "held welding torch" steady state.
const engC = new SparkEngine(POOL, { gravity: 800 });
const emit = makeEmitter({ x: 960, y: 800, rate: 900, cone: 0.5, speed: 800, life: 1.0 });
const laneC = timeLane(() => {
    emit.step(engC, DT);
    engC.updateAndDraw(ctx, DT, W, H);
}, 2000, 20000);
let aliveC = 0;
for (let i = 0; i < engC.state.length; i++) if (engC.state[i] !== 0) aliveC++;

// ---- provenance stamp ------------------------------------------------------
const stamp = {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0].model,
    date: new Date().toISOString().slice(0, 10),
    pool: POOL,
    dt: '1/60',
    caveat: 'stub-ctx, engine-only (no canvas rasterization)',
};

console.log('lite-sparks bench -- ' + JSON.stringify(stamp));
console.log('');
console.log('provenance: node ' + stamp.node + ' | ' + stamp.platform + '/' + stamp.arch +
    ' | ' + stamp.cpu + ' | ' + stamp.date);
console.log('caveat:     ' + stamp.caveat + ' | pool=' + POOL + ' | dt=1/60 | warmup=2000, reps=20000, MEDIAN');
console.log('');
console.log('Lane A  burst throughput   : ' + laneA.median.toFixed(4) + ' ms/burst (median), ' +
    laneA.min.toFixed(4) + ' ms min | ' + BURST_N + ' sparks/burst -> ' +
    (sparksPerSec / 1e6).toFixed(1) + ' M sparks/sec');
console.log('Lane B  full-frame @' + alignedB + ' alive : ' + laneB.median.toFixed(4) +
    ' ms/frame (median), ' + laneB.min.toFixed(4) + ' ms min -> ' +
    (1000 / laneB.median).toFixed(0) + ' fps headroom');
console.log('Lane C  sustained emission : ' + laneC.median.toFixed(4) +
    ' ms/frame (median), ' + laneC.min.toFixed(4) + ' ms min | ~' + aliveC +
    ' alive -> ' + (1000 / laneC.median).toFixed(0) + ' fps headroom');
