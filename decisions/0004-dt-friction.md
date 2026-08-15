# 0004 -- Friction is `pow(friction, dt*60)` per frame; floor restitution is left alone

- Status: accepted
- Date: 2026-08-15
- Session: S2 (v1.1.0)
- Finding: S-04

## Context

v1.0.2 applied air friction as a bare per-frame multiply:

```js
this.vx[i] *= this.config.friction;   // 0.99
this.vy[i] *= this.config.friction;
```

This is **frame-rate dependent**. `friction` is a per-frame retention factor, so
the velocity retained after one second is `friction^(fps)`: `0.99^60 ~= 0.547`
at 60fps but `0.99^120 ~= 0.299` at 120fps and `0.99^30 ~= 0.740` at 30fps. The
same scene drifts ~28px apart over one second between 30fps and 120fps -- the
faster the display, the more drag, which is backwards and untunable. Physics that
depends on how fast the monitor refreshes is a bug, not a knob.

## Decision

Convert friction to a dt-parameterised retention factor, computed **once per
frame** (hoisted above the per-particle loop, next to `floorBase`):

```js
const f = Math.pow(this.config.friction, dt * 60);
```

and apply it per particle:

```js
this.vx[i] *= f;
this.vy[i] *= f;
```

`friction` keeps its meaning as "retention per 1/60s frame", and `dt*60` is the
number of such frames the real `dt` represents. Retention over `dt` is therefore
`friction^(dt*60)`, which composes correctly under subdivision: retaining over
`dt` equals retaining over `dt/2` twice, because
`pow(f, dt*60) === pow(f, (dt/2)*60) * pow(f, (dt/2)*60)`. Friction is now
frame-rate independent; the terminal-velocity balance (gravity in, friction out)
lands at the same speed regardless of refresh rate.

This is confetti's isotropic per-frame `drag` model borrowed wholesale: a single
scalar retention raised to the frame count, applied to both velocity components.

### The 60fps byte-identity proof (the calibration anchor)

The suite's calibration anchor is 60fps output. At `dt = 1/60`:

- `dt * 60 === 1` exactly. `1/60` is not representable in binary64, but the
  product `(1/60) * 60` rounds back to exactly `1.0` in IEEE-754 (empirically
  verified: `(1/60)*60 === 1` is `true`).
- `Math.pow(0.99, 1) === 0.99` exactly (`pow(x, 1)` returns `x` unmodified).

So at 60fps `f === friction` bit-for-bit, and `v *= f` is the identical
operation to the old `v *= friction`. 600 frames at `dt = 1/60` stay
byte-identical to v1.0.2. Because `dt*60 === 1` is exact, **no special-case guard
is needed** -- the naive `pow` form already preserves the anchor. Adding an
`if (dt === 1/60)` fast path would only put bytes in the hot body for a branch
that changes nothing. Torture T0 law 4 pins the general dt-scaling property; the
T9 control replays the old per-frame model and proves that law can fail.

### Why floor `restitution` / `floorFriction` are NOT converted

Those two are **per-bounce**, applied inside the `y > floorY` branch, once per
floor-contact **event**, not once per frame:

```js
this.vy[i] *= -this.config.restitution;   // on contact
this.vx[i] *= this.config.floorFriction;  // on contact
```

An event that happens at most once per particle per bounce does not accumulate
with frame count -- doubling the frame rate does not double the number of
bounces. They are already frame-rate independent. Re-parameterising them by `dt`
would be wrong: it would scale an impulse by frame duration, changing bounce
energy with refresh rate -- introducing the exact bug S-04 removes. They are
correct as-is and are left untouched.

## Consequences

- 60fps output is byte-identical to v1.0.2 (the anchor holds). Air friction at
  30/120fps now converges to the 60fps trajectory instead of diverging ~28px/s.
- One new per-frame hoist (`f`), computed in the cold part of `updateAndDraw`
  before the loop. The per-particle body swaps two `config.friction` reads for
  two reads of the local `f` -- same op count, no allocation.
- dt-scaling law (T0): one `dt` step lands within tolerance of two `dt/2` steps
  on x/y/vx/vy (sub-pixel here -- only Euler gravity discretization remains, the
  friction term is exact across the two schedules). The pre-S-04 model fails this
  tolerance (T9 control).
- Floor restitution behavior is unchanged from v1.0.2.

## Rejected alternatives

- **Guard the 60fps case (`if (dt === 1/60) f = friction; else f = pow(...)`).**
  Rejected: `dt*60 === 1` is already exact, so the naive `pow` preserves the
  anchor with no guard. The branch would be dead bytes in a per-frame path.
- **Convert floor restitution to a per-frame factor too.** Rejected: restitution
  is a per-bounce impulse, not a per-frame decay; parameterising it by `dt` would
  make bounce energy depend on refresh rate -- the very bug being fixed.
- **Leave friction per-frame and document the fps dependence.** Rejected: a
  physics knob whose effect silently depends on the display refresh rate is not a
  knob. Frame-rate independence is the point of the release.
