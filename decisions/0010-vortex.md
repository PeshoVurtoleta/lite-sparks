# 0010 -- The vortex folds into the existing `if (aero)` gate; its accel is normalized and clamped to +/-VORTEX_MAX_ACCEL

- Status: accepted
- Date: 2026-08-15
- Session: S4b (v1.3.1)
- Finding: S-14

## Context

The S4b wave adds a vortex: a point that sparks are drawn toward and swirl
around. Two effects were asked for:

- **attract** -- a radial pull toward a center `(attractX, attractY)`; negative
  repels.
- **swirl** -- a tangential push perpendicular to the radius, so sparks orbit the
  center rather than fall straight into it.

Unlike wind/gust (a uniform field sampled once per frame, ADR 0008), the vortex
depends on each spark's OWN position -- the direction to the center differs per
spark -- so it cannot be pre-sampled into a single scalar. The constraint is
still the hot-path law: the default (attract==0 && swirl==0) body must stay
byte-identical to v1.2.0, and the vortex must not add a new per-particle gate on
top of the air-force gate.

## Decision

Fold the vortex into the SAME `if (aero)` branch the air forces already own, and
bound its acceleration with a module constant.

### One gate, extended -- not a new one

```js
const attract  = cfg.attract;
const swirl    = cfg.swirl;
const attractX = cfg.attractX;
const attractY = cfg.attractY;
const aero = wind !== 0 || gustNow !== 0 || turb !== 0 || attract !== 0 || swirl !== 0;
```

The vortex rides the existing `aero` disjunction. When every air knob AND both
vortex scalars are 0, `aero` is `false` and the whole block -- wind, gust,
turbulence, and vortex -- is skipped, so the body is byte-identical to v1.2.0.
The vortex adds ZERO new per-particle branches at the gate level; it adds one
inner `if (attract !== 0 || swirl !== 0)` that only runs when the outer gate is
already taken.

### The accel: normalized radial + tangential, per axis, clamped

```js
if (attract !== 0 || swirl !== 0) {
    const dx = attractX - xs[i];
    const dy = attractY - ys[i];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist !== 0) {
        const inv = 1 / dist;
        const nx = dx * inv, ny = dy * inv;         // radial unit vector toward center
        let ax = attract * nx - swirl * ny;         // radial + tangential (-ny, nx)
        let ay = attract * ny + swirl * nx;
        ax = ax < -VORTEX_MAX_ACCEL ? -VORTEX_MAX_ACCEL : ax > VORTEX_MAX_ACCEL ? VORTEX_MAX_ACCEL : ax;
        ay = ay < -VORTEX_MAX_ACCEL ? -VORTEX_MAX_ACCEL : ay > VORTEX_MAX_ACCEL ? VORTEX_MAX_ACCEL : ay;
        vxs[i] += ax * dt;
        vys[i] += ay * dt;
    }
}
```

- `(nx, ny)` is the radial UNIT vector toward the center; `(-ny, nx)` is its 90deg
  rotation (the tangent). `attract` scales the radial term, `swirl` the
  tangential. Normalizing by `dist` means the pull's DIRECTION is position-
  dependent but its raw magnitude is `attract` (radial) / `swirl` (tangential),
  not a `1/r`-blowing-up-near-the-center law -- a spark near the center does not
  get an unbounded kick from an un-normalized `dx` either.
- **`dist === 0` is skipped.** At the exact center the direction is undefined and
  `1/dist` is `Infinity`; the guard fails closed and that spark simply feels no
  vortex this frame -- no divide-by-zero, no NaN. The node:test "spark exactly AT
  the center" case pins this.
- **Zero allocation.** Every operand is a hoisted scalar or an SoA read; `dx`,
  `dy`, `dist`, `nx`, `ny`, `ax`, `ay` are stack locals. No temp object, no array,
  no `Math.hypot` allocation concern (a plain `sqrt` of a sum).

### `VORTEX_MAX_ACCEL = 4000` -- 5x the default gravity

```js
const VORTEX_MAX_ACCEL = 4000; // 5x default gravity (800)
```

Each axis of the combined accel is clamped to `+/-4000` px/s^2. This is the
fail-closed bound on a HOSTILE scalar. Because the direction is normalized, a
sane `attract`/`swirl` is already bounded by `|attract| + |swirl|`; the clamp
exists so that `attract = -1e9` (or any absurd value) cannot deliver a per-frame
velocity kick of `|attract| * dt` (~1.667e7 px/s at dt=1/60) that teleports a
spark off-screen or, over a run, walks a coordinate toward the float ceiling.
With the clamp, the worst-case kick is `4000 * dt = 66.7` px/s per frame -- a
strong but physical pull. 4000 = 5x the 800 default gravity: firmly dominant over
gravity (a spark near the vortex orbits it, not the floor) without being violent.
The T0 witness proves both directions: `attract=+2000` cuts a spark's distance to
the center by >50%, and `attract=-1e9` stays finite with `|a| <= 4000`. The T9
control C proves the clamp is load-bearing: the real engine's per-frame kick is
bounded under 100 px/s where the un-clamped accel would be 1.667e7.

### Non-finite scalars fail closed (sanitized once, in the cold constructor)

`aero` is a `!== 0` disjunction, and `NaN !== 0` is `true`, so a non-finite
`attract`/`swirl` would switch the gate ON and feed `vx += NaN` -- the S-01
whole-pool poison class (ADR 0008) through the vortex door. The center coords
`attractX`/`attractY` feed `dx`/`dy` and would NaN the accel the same way. All
four are coerced to `0` once in the constructor:

```js
if (!Number.isFinite(this.config.attract))  this.config.attract  = 0;
if (!Number.isFinite(this.config.swirl))    this.config.swirl    = 0;
if (!Number.isFinite(this.config.attractX)) this.config.attractX = 0;
if (!Number.isFinite(this.config.attractY)) this.config.attractY = 0;
```

Cold, constructor-only, zero hot bytes.

### `attractX`/`attractY` default to 0, not a runtime center

The center is only READ when `attract !== 0 || swirl !== 0`, i.e. when the caller
has explicitly turned the vortex on. So the off-safe default is `0` -- the caller
who sets `attract` also sets the center. The tempting alternative -- defaulting
the center to `(w/2, h/2)` -- is rejected: `w`/`h` are frame arguments to
`updateAndDraw`, not available in the cold constructor, so a runtime center would
have to be computed per frame (a cold cost for a value the caller can pass) or
would silently move when the caller resizes the canvas. `0` is the honest,
fail-closed default; the vortex is inert at the default anyway.

## Consequences

- Per-particle cost when the vortex is off: nothing beyond the shared `if (aero)`
  gate, which is already false at the default. Byte-identical to v1.2.0 (torture
  T0 laws 6 + 12-13; the vortex/swirl fingerprints differ from aero-off, proving
  the term does real work when on).
- Per-particle cost when the vortex is on: one `sqrt`, one reciprocal, four
  multiplies, two clamps, two adds -- all on hoisted scalars and SoA reads. Zero
  allocation (torture T6 vortex + containment-all lanes pin all 12 backing stores
  unchanged, maxMajor 0).
- One module constant (`VORTEX_MAX_ACCEL`), four cold config reads per frame. No
  new SoA column: the vortex needs only the spark's existing x/y.
- The vortex, like the air forces, lives inside the S-05 moving gate, so it never
  wakes a resting ember (node:test "vortex acts only on moving sparks").

## Rejected alternatives

- **A `1/r^2` (Newtonian) pull, un-normalized.** REJECTED. It blows up near the
  center (the very region a vortex draws sparks into), demanding a softening
  constant and a clamp anyway, and it makes the far-field pull negligible so the
  vortex barely reaches sparks. A normalized direction with a scalar magnitude +
  a single global clamp is simpler and bounded everywhere.
- **A per-spark timestamp / phase column for the swirl.** REJECTED. The swirl
  direction is derived from the spark's live position each frame, so no stored
  state is needed -- zero new column, mirroring how turbulence reused `invLife`
  (ADR 0008).
- **A second `if (vortex)` gate beside `if (aero)`.** REJECTED. It is a second
  per-particle branch every spark pays. Extending the existing `aero` disjunction
  with `attract !== 0 || swirl !== 0` collapses it into the one branch that is
  already false at the default.
- **Defaulting the center to the canvas midpoint.** REJECTED -- see above; `w`/`h`
  are frame-time inputs, so a runtime center is a cold per-frame cost or a
  silently-desyncing value. `0` is the fail-closed default and the vortex is inert
  until the caller sets both the scalar and the center.
- **No clamp (trust the caller's `attract`).** REJECTED. Config numerics are a
  hostile surface (the S-01 lesson): an absurd `attract` would teleport a spark or
  walk a coordinate to the float ceiling over a run. `VORTEX_MAX_ACCEL` bounds the
  per-frame kick; the T9 control C proves the bound is load-bearing.
