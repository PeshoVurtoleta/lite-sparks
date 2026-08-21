/**
 * T1 -- degenerate values (the hostile-input door).
 *
 * S1 (v1.0.2) closed the two doors, so these assertions now pin the FIXED
 * behavior (the S0 KNOWN-BUG markers are gone for the fixed cases):
 *
 *   - S-01: every hostile `dt` leaves every live particle finite. A rejected
 *     `dt` (NaN, -0, 0, negatives, -Inf) is a no-op frame; a huge finite / +Inf
 *     is clamped to 0.1; a subnormal (1e-45) runs a tiny step. `aliveFinite`
 *     holds in every case.
 *   - S-02: hostile `count` (0, -5, NaN, Inf) spawns 0; 1.5 floors to 1; a valid
 *     count spawns min(count, freeSlots).
 *   - S-11: a life=0 spawn never produces Infinity in invLife or NaN in colorIdx.
 *   - w/h in {0, -1, NaN}: a degenerate floor/bound never poisons a particle to
 *     NaN/Infinity and never hangs.
 *
 * A poisoned frame is observed through `aliveFinite`: it is false the instant a
 * NaN/Inf value reaches the physics loop, where a heap gate would see nothing.
 */

import { SparkEngine } from '../../SparkEngine.js';
import { check, stubCtx, aliveCount, aliveFinite } from './harness.mjs';

const W = 800;
const H = 600;
const TAU = Math.PI * 2;

/** Fresh full-of-life engine: 10 sparks, deterministic rng. */
function seeded() {
    const e = new SparkEngine(100, { rng: () => 0.5 });
    e.burst(400, 300, 10, 0, TAU, 100, 500);
    return e;
}

export function run() {
    // --- hostile dt (S-01, FIXED) ------------------------------------------
    // The door `if (!(dt > 0)) return;` rejects NaN/-0/0/negatives/-Inf as a
    // no-op frame; +Inf and 1e9 clamp to 0.1; 1e-45 is a tiny real step. Every
    // case leaves every live particle finite and never changes alive count via
    // poison.
    const dtCases = [
        ['0', 0],
        ['-0', -0],
        ['-1', -1],
        ['NaN', NaN],
        ['+Inf', Infinity],
        ['-Inf', -Infinity],
        ['1e-45', 1e-45],   // subnormal positive: passes the door, tiny real step
        ['1e9', 1e9],       // huge finite: clamped to 0.1
    ];
    for (const [name, dt] of dtCases) {
        const e = seeded();
        const before = aliveCount(e);
        e.updateAndDraw(stubCtx, dt, W, H);
        check(aliveFinite(e),
            () => 'T1.dt[' + name + ']: a live particle went non-finite -- the S-01 door leaked');
        // A rejected dt (no-op) or a clamped/tiny step must not cull via poison;
        // for the frames that DO run, one 0.1-or-smaller step keeps all 10 alive.
        check(aliveCount(e) === before,
            () => 'T1.dt[' + name + ']: alive changed ' + before + ' -> ' + aliveCount(e) +
                  ' (fixed v1.0.2 -- S-01)');
    }

    // A no-op dt must be a true no-op: the snapshot is byte-identical afterwards.
    {
        const e = seeded();
        const x0 = e.x[0], y0 = e.y[0], vy0 = e.vy[0], life0 = e.life[0];
        e.updateAndDraw(stubCtx, NaN, W, H);
        check(Object.is(e.x[0], x0) && Object.is(e.y[0], y0) &&
              Object.is(e.vy[0], vy0) && Object.is(e.life[0], life0),
            () => 'T1.dt[NaN]: no-op frame still mutated the snapshot (S-01)');
    }

    // --- hostile count (S-02, FIXED) ---------------------------------------
    // The door `count = count >= 1 ? (count|0) : 0; if (count===0) return;`
    // maps 0/-5/NaN/Inf -> 0 spawned and floors 1.5 -> 1. max+1 -> min(count,max).
    const countCases = [
        ['0', 0, 0],
        ['-5', -5, 0],
        ['NaN', NaN, 0],
        ['Inf', Infinity, 0],
        ['1.5', 1.5, 1],
        ['max+1', 101, 100],
    ];
    for (const [name, count, expected] of countCases) {
        const e = new SparkEngine(100, { rng: () => 0.5 });
        e.burst(400, 300, count, 0, TAU, 100, 500);
        check(aliveCount(e) === expected,
            () => 'T1.count[' + name + ']: alive=' + aliveCount(e) + ' expected ' + expected +
                  ' (fixed v1.0.2 -- S-02)');
        check(aliveFinite(e),
            () => 'T1.count[' + name + ']: a spawned particle is non-finite');
    }

    // --- hostile burst cone/speed/life args (S-16, FIXED) ------------------
    // The S-16 door coerces each of the six cone/speed/life args independently
    // with Number.isFinite at burst() entry (angleMin/Max->0, speedMin/Max->0
    // riding the S-05 epsilon, lifeMin->0.5/lifeMax->1.5). 18 lanes: each of the
    // six args set to {NaN, +Inf, -Inf} in turn while the other five stay valid.
    // Every lane must leave every spawned spark finite AND spawn exactly count
    // (the door sanitizes the args; the S-02 count door still spawns count=10).
    {
        const COUNT = 10;
        // [name, argIndex] -- positions into the burst arg tuple below.
        const ARGS = [
            ['angleMin', 0], ['angleMax', 1],
            ['speedMin', 2], ['speedMax', 3],
            ['lifeMin', 4], ['lifeMax', 5],
        ];
        const HOSTILE = [['NaN', NaN], ['+Inf', Infinity], ['-Inf', -Infinity]];
        for (const [aname, ai] of ARGS) {
            for (const [hname, hv] of HOSTILE) {
                // Valid baseline for the six cone/speed/life args, one poisoned.
                const a = [0, TAU, 100, 500, 0.5, 1.5];
                a[ai] = hv;
                const e = new SparkEngine(100, { rng: () => 0.5 });
                e.burst(400, 300, COUNT, a[0], a[1], a[2], a[3], a[4], a[5]);
                check(aliveCount(e) === COUNT,
                    () => 'T1.burst[' + aname + '=' + hname + ']: alive=' + aliveCount(e) +
                          ' expected ' + COUNT + ' (S-16 sanitizes args, count still spawns)');
                check(aliveFinite(e),
                    () => 'T1.burst[' + aname + '=' + hname + ']: a spawned spark went non-finite -- the S-16 door leaked');
                // One physics frame must not resurrect a poison the door caught.
                e.updateAndDraw(stubCtx, 1 / 60, W, H);
                check(aliveFinite(e),
                    () => 'T1.burst[' + aname + '=' + hname + ']: a spark went non-finite after one frame (S-16)');
            }
        }
    }

    // --- life=0 spawn (S-11, FIXED) ----------------------------------------
    // lifeMin=lifeMax=0 computes life<=0; the spawn clamp keeps invLife finite
    // and colorIdx a valid index.
    {
        const e = new SparkEngine(20, { rng: () => 0.5 });
        e.burst(400, 300, 5, 0, TAU, 100, 500, 0, 0);
        for (let i = 0; i < e.max; i++) {
            if (e.state[i] !== 1) continue;
            check(Number.isFinite(e.invLife[i]),
                () => 'T1.life0: invLife[' + i + ']=' + e.invLife[i] + ' not finite (S-11)');
            check(e.life[i] > 0,
                () => 'T1.life0: life[' + i + ']=' + e.life[i] + ' not clamped above 0 (S-11)');
            const colorIdx = Math.floor((e.life[i] * e.invLife[i]) * e.colors.length);
            check(Number.isFinite(colorIdx),
                () => 'T1.life0: colorIdx=' + colorIdx + ' is NaN (S-11)');
        }
    }

    // --- degenerate w / h (finite-safety) ----------------------------------
    // A zero/negative/NaN bound or floor must never poison a live particle to
    // NaN/Infinity and must return (no hang). Some values cull everything (an
    // exact-edge x>w with w<=0), which is fine -- the invariant is finiteness.
    const dims = [0, -1, NaN];
    for (const w of [W, ...dims]) {
        for (const h of [H, ...dims]) {
            const e = seeded();
            e.updateAndDraw(stubCtx, 1 / 60, w, h);
            check(aliveFinite(e),
                () => 'T1.dim[w=' + w + ',h=' + h + ']: a live particle went non-finite');
        }
    }

    // --- speed=0 (S-05 is S2's fix; here only assert finiteness) -----------
    {
        const e = new SparkEngine(10, { rng: () => 0.5 });
        e.burst(400, 100, 1, 0, 0, 0, 0, 5, 5); // vx=vy=0 exactly
        for (let f = 0; f < 10; f++) e.updateAndDraw(stubCtx, 0.1, W, H);
        check(aliveFinite(e),
            () => 'T1.speed0: a zero-speed spark went non-finite');
    }

    // --- inverted angle range (finite-safety) ------------------------------
    {
        const e = new SparkEngine(10, { rng: () => 0.5 });
        e.burst(400, 300, 5, TAU, 0, 100, 500); // angleMin > angleMax
        e.updateAndDraw(stubCtx, 1 / 60, W, H);
        check(aliveFinite(e),
            () => 'T1.angle: inverted angle range produced a non-finite particle');
    }

    // --- degenerate maxParticles at construction (finite-safety) -----------
    for (const mx of [0, 1]) {
        const e = new SparkEngine(mx, { rng: () => 0.5 });
        e.burst(400, 300, 5, 0, TAU, 100, 500);
        e.updateAndDraw(stubCtx, 1 / 60, W, H);
        check(aliveFinite(e),
            () => 'T1.maxParticles[' + mx + ']: non-finite particle');
        check(aliveCount(e) <= mx,
            () => 'T1.maxParticles[' + mx + ']: alive ' + aliveCount(e) + ' exceeds pool ' + mx);
    }
}
