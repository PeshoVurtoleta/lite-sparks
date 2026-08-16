/**
 * @zakkster/lite-sparks -- S-14 containment (v1.3.1) boundary suite.
 *
 * The containment wave adds seven cold config keys -- three walls
 * (wallLeft / wallRight / ceiling) and a four-part vortex (attract / swirl /
 * attractX / attractY) -- one hoisted `if (walls)` after the floor block and the
 * vortex accel folded into the existing `if (aero)` gate. These are the
 * unit-level companions to the torture-tier T0/T6/T9 laws, at a size node:test
 * runs in milliseconds:
 *
 *   - defaults + fail-closed coercions (walls non-finite -> null; vortex -> 0)
 *   - wallLeft/wallRight/ceiling contain + reflect a moving spark
 *   - a wall AT 0 is honoured (null is not zero)
 *   - walls + vortex never wake a resting ember (inside the S-05 moving gate)
 *   - attract pulls radially; swirl pushes tangentially; the per-axis clamp
 *     bounds a hostile attract; dist===0 at the center is skipped (no NaN)
 *   - containment-off is byte-identical to the v1.2.0 default path
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkEngine } from '../SparkEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}
function floatRng(seed) {
    const p = makePrng(seed);
    return () => p() / 4294967296;
}

/** Seed one hand-placed free-flight spark into slot 0 (tall canvas, no floor). */
function seedSpark(e, { x = 400, y = 500, vx = 0, vy = -100, life = 100 } = {}) {
    e.state[0] = 1; e.x[0] = x; e.y[0] = y; e.vx[0] = vx; e.vy[0] = vy;
    e.life[0] = life; e.invLife[0] = 1 / life; e.weight[0] = 2;
}

/** True iff every live particle's x/y/vx/vy/life is finite (the S-01 detector). */
function aliveFinite(e) {
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 1) continue;
        if (!(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]) &&
              Number.isFinite(e.vx[i]) && Number.isFinite(e.vy[i]) &&
              Number.isFinite(e.life[i]))) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Defaults + fail-closed coercions (cold path).
// ---------------------------------------------------------------------------

test('S-14: containment knobs default off (walls null, vortex 0)', () => {
    const e = new SparkEngine(8, { rng: () => 0.5 });
    assert.equal(e.config.wallLeft, null);
    assert.equal(e.config.wallRight, null);
    assert.equal(e.config.ceiling, null);
    assert.equal(e.config.attract, 0);
    assert.equal(e.config.swirl, 0);
    assert.equal(e.config.attractX, 0);
    assert.equal(e.config.attractY, 0);
});

test('S-14: a non-finite wall bound is coerced to null (fail closed -- no wall)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        assert.equal(new SparkEngine(4, { rng: () => 0.5, wallLeft: bad }).config.wallLeft, null);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, wallRight: bad }).config.wallRight, null);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, ceiling: bad }).config.ceiling, null);
    }
});

test('S-14: a wall AT 0 is HONORED (finite) -- null is not zero', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, wallLeft: 0, wallRight: 0, ceiling: 0 });
    assert.equal(e.config.wallLeft, 0);
    assert.equal(e.config.wallRight, 0);
    assert.equal(e.config.ceiling, 0);
});

test('S-14: a non-finite vortex scalar is coerced to 0 (fail closed -- S-01 stays shut)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        assert.equal(new SparkEngine(4, { rng: () => 0.5, attract: bad }).config.attract, 0);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, swirl: bad }).config.swirl, 0);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, attractX: bad }).config.attractX, 0);
        assert.equal(new SparkEngine(4, { rng: () => 0.5, attractY: bad }).config.attractY, 0);
    }
});

// ---------------------------------------------------------------------------
// Containment-off is byte-identical to the v1.2.0 default path.
// ---------------------------------------------------------------------------

test('S-14: containment-off is byte-identical to the default (v1.2.0) path over a seeded run', () => {
    const max = 96;
    const a = new SparkEngine(max, { rng: floatRng(777) }); // default
    const b = new SparkEngine(max, {
        rng: floatRng(777),
        wallLeft: null, wallRight: null, ceiling: null, attract: 0, swirl: 0, attractX: 0, attractY: 0,
    });
    for (let f = 0; f < 60; f++) {
        if (f % 5 === 0) {
            a.burst(400, 300, 8, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
            b.burst(400, 300, 8, 0, Math.PI * 2, 50, 400, 0.3, 0.9);
        }
        a.updateAndDraw(ctx, 1 / 60, 800, 600);
        b.updateAndDraw(ctx, 1 / 60, 800, 600);
    }
    for (let i = 0; i < max; i++) {
        assert.equal(a.state[i], b.state[i], 'state[' + i + '] diverged');
        assert.ok(Object.is(a.x[i], b.x[i]) && Object.is(a.y[i], b.y[i]), 'pos[' + i + '] diverged');
        assert.ok(Object.is(a.vx[i], b.vx[i]) && Object.is(a.vy[i], b.vy[i]), 'vel[' + i + '] diverged');
        assert.ok(Object.is(a.life[i], b.life[i]), 'life[' + i + '] diverged');
    }
});

// ---------------------------------------------------------------------------
// Walls: contain + reflect.
// ---------------------------------------------------------------------------

test('S-14: wallLeft clamps x and reflects vx (a leftbound spark is turned around)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, wallLeft: 100 });
    seedSpark(e, { x: 400, vx: -500, vy: 1e-3 });
    for (let f = 0; f < 60; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(e.x[0] >= 100 - 1e-3, 'spark escaped past wallLeft: x=' + e.x[0]);
    assert.ok(e.vx[0] > 0, 'wallLeft did not reflect vx to +x: vx=' + e.vx[0]);
});

test('S-14: wallRight clamps x and reflects vx (a rightbound spark is turned around)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, wallRight: 700 });
    seedSpark(e, { x: 400, vx: 500, vy: 1e-3 });
    for (let f = 0; f < 60; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(e.x[0] <= 700 + 1e-3, 'spark escaped past wallRight: x=' + e.x[0]);
    assert.ok(e.vx[0] < 0, 'wallRight did not reflect vx to -x: vx=' + e.vx[0]);
});

test('S-14: ceiling clamps y and reflects vy (an upward spark is turned back down)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, ceiling: 0 });
    seedSpark(e, { x: 400, y: 500, vx: 0, vy: -800 });
    let minY = Infinity, flipped = false;
    for (let f = 0; f < 60; f++) {
        e.updateAndDraw(ctx, 1 / 60, 800, 100000);
        if (e.y[0] < minY) minY = e.y[0];
        if (e.vy[0] > 0) flipped = true;
    }
    assert.ok(minY >= 0 - 1e-3, 'spark escaped above the ceiling: min y=' + minY);
    assert.ok(flipped, 'ceiling did not reflect vy to +y');
});

test('S-14: a wall contains a spark that would otherwise X-cull (8/8 alive vs 0)', () => {
    const seed8 = (e) => {
        for (let i = 0; i < 8; i++) {
            e.state[i] = 1; e.x[i] = 400; e.y[i] = 500; e.vx[i] = -500; e.vy[i] = 1e-3;
            e.life[i] = 100; e.invLife[i] = 1 / 100; e.weight[i] = 2;
        }
    };
    const noWall = new SparkEngine(8, { rng: () => 0.5, friction: 1, gravity: 0 });
    seed8(noWall);
    for (let f = 0; f < 90; f++) noWall.updateAndDraw(ctx, 1 / 60, 800, 100000);
    let aliveNo = 0; for (let i = 0; i < 8; i++) if (noWall.state[i] === 1) aliveNo++;
    assert.equal(aliveNo, 0, 'without a wall the leftbound sparks should X-cull to 0');

    const withWall = new SparkEngine(8, { rng: () => 0.5, friction: 1, gravity: 0, wallLeft: 100 });
    seed8(withWall);
    for (let f = 0; f < 60; f++) withWall.updateAndDraw(ctx, 1 / 60, 800, 100000);
    let aliveYes = 0; for (let i = 0; i < 8; i++) if (withWall.state[i] === 1) aliveYes++;
    assert.equal(aliveYes, 8, 'wallLeft should contain all 8 sparks');
});

test('S-14: walls never wake a resting ember (inside the S-05 moving gate)', () => {
    const e = new SparkEngine(4, { rng: () => 0.5, wallLeft: 500, wallRight: 300, ceiling: 400 });
    // Resting spark placed OUTSIDE every bound: if walls ran on a resting spark it
    // would be yanked onto a wall. It must stay put (vx==vy==0 -> physics bypassed).
    e.state[0] = 1; e.x[0] = 400; e.y[0] = 300; e.vx[0] = 0; e.vy[0] = 0;
    e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 600);
    assert.equal(e.x[0], 400, 'a resting spark was moved in x by a wall');
    assert.equal(e.y[0], 300, 'a resting spark was moved in y by a wall');
    assert.equal(e.vx[0], 0);
    assert.equal(e.vy[0], 0);
});

// ---------------------------------------------------------------------------
// Vortex: attract (radial) + swirl (tangential) + the per-axis clamp.
// ---------------------------------------------------------------------------

test('S-14: attract=+2000 pulls a spark toward the center (distance cut by > 50%)', () => {
    const CX = 400, CY = 500, D0 = 300;
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: 2000, attractX: CX, attractY: CY });
    seedSpark(e, { x: CX + D0, y: CY, vx: 0, vy: 1e-3 });
    let minD = Infinity;
    for (let f = 0; f < 60; f++) {
        e.updateAndDraw(ctx, 1 / 60, 800, 100000);
        const d = Math.hypot(e.x[0] - CX, e.y[0] - CY);
        if (d < minD) minD = d;
    }
    assert.ok(minD < 0.5 * D0, 'attract did not cut distance by > 50%: min dist ' + minD.toFixed(2));
});

test('S-14: negative attract REPELS (distance grows)', () => {
    const CX = 400, CY = 500, D0 = 100;
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: -2000, attractX: CX, attractY: CY });
    seedSpark(e, { x: CX + D0, y: CY, vx: 0, vy: 1e-3 });
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(Math.hypot(e.x[0] - CX, e.y[0] - CY) > D0, 'negative attract did not repel');
});

test('S-14: a hostile attract=-1e9 stays finite -- the per-axis clamp bounds |a| (<= 4000)', () => {
    const CX = 400, CY = 500;
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: -1e9, attractX: CX, attractY: CY });
    seedSpark(e, { x: CX + 300, y: CY, vx: 0, vy: 1e-3 });
    // One frame: the velocity kick is bounded by VORTEX_MAX_ACCEL*dt = 66.7, not
    // |attract|*dt = 1.667e7. Then a long run must stay finite.
    e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(Math.abs(e.vx[0]) <= 100, 'the vortex kick exceeded the clamp bound: |vx|=' + Math.abs(e.vx[0]));
    for (let f = 0; f < 1000; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(aliveFinite(e), 'a hostile attract went non-finite -- the clamp failed');
});

test('S-14: swirl pushes tangentially (a spark on the +x side of the center moves in y)', () => {
    const CX = 400, CY = 500, D0 = 300;
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, swirl: 2000, attractX: CX, attractY: CY });
    seedSpark(e, { x: CX + D0, y: CY, vx: 0, vy: 1e-3 });
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 100000);
    assert.ok(Math.abs(e.y[0] - CY) > 1, 'swirl did not move the spark tangentially in y');
    assert.ok(Math.hypot(e.x[0] - CX, e.y[0] - CY) > 1, 'swirl collapsed the spark onto the center');
});

test('S-14: a spark exactly AT the vortex center is skipped (dist===0, no divide-by-zero NaN)', () => {
    const CX = 400, CY = 500;
    const e = new SparkEngine(4, { rng: () => 0.5, friction: 1, gravity: 0, attract: 2000, swirl: 2000, attractX: CX, attractY: CY });
    // Placed exactly on the center but moving (vy != 0) so it enters the vortex block.
    seedSpark(e, { x: CX, y: CY, vx: 0, vy: 1e-3 });
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 1 / 60, 800, 100000));
    assert.ok(aliveFinite(e), 'a spark at the vortex center went non-finite (dist===0 not guarded)');
});

test('S-14: the vortex acts only on MOVING sparks -- a resting ember is untouched', () => {
    const CX = 400, CY = 500;
    const e = new SparkEngine(4, { rng: () => 0.5, attract: 2000, swirl: 2000, attractX: CX, attractY: CY });
    e.state[0] = 1; e.x[0] = CX + 200; e.y[0] = CY; e.vx[0] = 0; e.vy[0] = 0; // asleep off-center
    e.life[0] = 100; e.invLife[0] = 1 / 100; e.weight[0] = 2;
    const x0 = e.x[0];
    for (let f = 0; f < 30; f++) e.updateAndDraw(ctx, 1 / 60, 800, 600);
    assert.equal(e.x[0], x0, 'the vortex pulled a resting spark (aero leaked outside the moving gate)');
    assert.equal(e.vx[0], 0);
    assert.equal(e.vy[0], 0);
});
