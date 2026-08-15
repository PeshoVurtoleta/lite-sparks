# 0008 -- Wind, gust, and turbulence are one force model behind a single hoisted `if (aero)`

- Status: accepted
- Date: 2026-08-15
- Session: S4 (v1.3.0)
- Finding: S-13

## Context

The S4 wave adds moving air. Three distinct effects were asked for:

- **wind** -- a constant directional push (a draft across the scene).
- **gust** -- wind that swells and fades (a periodic amplitude on the push).
- **turbulence** -- small-scale chaos, each ember buffeted differently from its
  neighbour (eddies, not a bulk flow).

The hard constraint is the hot-path law. This engine's whole identity is a
zero-GC, byte-stable per-particle loop; v1.2.0 froze the aero-off per-particle
body as a calibration anchor. Three new forces must NOT become three new
per-particle branches that every spark pays every frame, and the default
(all-off) body must stay byte-identical to v1.2.0.

## Decision

Treat all three as ONE force model with ONE gate, ONE clock, and ONE cold
preheader hoist. The per-particle body gains exactly one `if (aero)`; everything
else is cold.

### One clock

A single cold scalar `this._elapsed` accumulates simulated dt, advanced once per
frame in the preheader (after the dt door, so a rejected frame does not tick the
clock):

```js
this._elapsed += dt;
const el = this._elapsed;
```

Both time-varying forces (gust, turbulence) read `el`. No per-spark timestamp
column exists or is needed.

### One preheader hoist, one gate

```js
const wind = cfg.wind;
const turb = cfg.turbulence;
const gust = cfg.gust;
const gustNow = gust !== 0 ? Math.sin(el * GUST_HZ) * gust : 0;   // sampled ONCE
const aero = wind !== 0 || gustNow !== 0 || turb !== 0;
```

`gustNow` is the gust field for the whole frame, evaluated once in the cold path
-- `Math.sin` is never called per particle. `GUST_HZ = TAU/3` gives a 3-second
period: slow enough to read as a swelling draft, not a flicker. Because gust adds
to a shared horizontal field, it collapses into the wind term: the field this
frame is simply `wind + gustNow`.

`aero` is the single hot-loop gate. When every knob is 0, `aero` is `false` and
the block below is skipped entirely, so the per-particle body is the v1.2.0 body,
byte-for-byte.

### One hot block, before the floor test

```js
if (aero) {
    if (wind !== 0 || gustNow !== 0) vxs[i] += (wind + gustNow) * dt;
    if (turb !== 0) {
        const p = invLifeA[i] * TURB_K + el;
        vxs[i] += Math.cos(p) * turb * dt;
        vys[i] += Math.sin(p) * turb * dt;
    }
}
```

Wind + gust push the shared horizontal field. Turbulence is a per-spark curl:
`(cos p, sin p)` is a unit vector rotating with phase `p`, so it nudges each
spark in a direction that depends on `p` and never systematically drains or
pumps energy the way a fixed push would.

### Turbulence reuses `invLife` as its phase -- no new column

The phase source is `invLife[i]`, already stored per spawn, already rng-derived,
already unique per spark. Multiplying by `TURB_K = 1000` (>= 1000 by design)
makes the 1/life spread dominate the shared `el` term, so two sparks with
near-equal life still land on very different phases and wander in DIFFERENT
directions -- the defining property of turbulence. A smaller `TURB_K` would let
`el` dominate and make neighbours share a wander direction (bulk sway, not
chaos). Reusing `invLife` means turbulence adds zero new SoA column, zero new
spawn write, and zero new draw work.

The forces are applied to velocity in the existing velocity-update section (after
friction, before the position integration and the floor test), so a moving spark
feels the air this frame. This placement keeps the whole feature inside the
existing `if (vx !== 0 || vy !== 0)` moving block.

### Non-finite knobs fail closed (sanitized once, in the cold constructor)

The `aero` gate is a `!== 0` disjunction, and `NaN !== 0` / `Infinity !== 0` are
both `true` -- so a non-finite `wind`/`gust`/`turbulence` would switch aero ON
and feed `vx += (NaN + ..) * dt`, NaN-ing every live moving spark. That is the
S-01 whole-pool-poison class (fixed for `dt` in v1.0.2) re-opened through the
config door. The suite's fail-closed law (an unverified state is treated as safe,
not trusted) applies to config numerics too, so each air knob is coerced to `0`
(off) once in the constructor:

```js
if (!Number.isFinite(this.config.wind)) this.config.wind = 0;
if (!Number.isFinite(this.config.gust)) this.config.gust = 0;
if (!Number.isFinite(this.config.turbulence)) this.config.turbulence = 0;
```

The `drag` alias (ADR 0007) has the same hazard from a different angle: a
non-finite `drag` satisfies `!= null`, clobbers `friction`, and then
`f = pow(NaN, dt*60)` NaNs the pool EVEN WITH AERO OFF. So the alias is guarded
to require a finite value; a non-finite `drag` is ignored and `friction` keeps
its default/explicit value:

```js
if (this.config.drag != null && Number.isFinite(this.config.drag)) {
    this.config.friction = this.config.drag;
}
```

Both coercions are cold (constructor only) -- zero hot bytes. `null` is still
distinct from `0`: `null`/`undefined` mean "knob unset, keep the default", while
`0` is a meaningful value that is honoured (null is not zero). Only non-finite
values are treated as off/ignored. The hot loop is guaranteed a finite `aero`
field and a finite `friction`, so a hostile config can never NaN the pool.

## Consequences

- Per-particle cost when aero is off: one `if (aero)` that is false -- the body is
  byte-identical to v1.2.0. Default seeded runs are Object.is-identical across
  x/y/vx/vy/life/state (torture T0 law 6).
- Per-particle cost when aero is on: at most one field add plus, for turbulence,
  one `cos`/`sin` pair. Still zero allocation -- all operands are hoisted scalars
  or existing SoA reads.
- One cold scalar (`_elapsed`), one cold `sin` (`gustNow`), four cold config
  reads per frame. `_elapsed` is nulled implicitly on nothing (it is a number, not
  an array) and plays no part in `destroy()`.
- Torture T6 pins all 12 backing-store byte lengths unchanged across four aero
  lanes (wind / gust / turbulence / all-on): the feature grows no buffer.

## Rejected alternatives

- **"Wind wakes resting embers."** REJECTED. The tempting extension: let wind
  apply to sleeping sparks too, so a resting ember on the floor is nudged back
  into motion by a draft. Rejected on two grounds. (1) It is a hot-path cost with
  no gate: waking sleepers means running the aero add for state-1-but-resting
  sparks, which defeats the S-05 sleep optimisation (physics is bypassed for
  resting sparks precisely so a full floor of dead embers costs nothing). Moving
  the aero add OUTSIDE the `if (vx !== 0 || vy !== 0)` moving block would make
  every resting spark pay the aero branch every frame -- exactly the per-particle
  tax this ADR exists to avoid. (2) It changes the aero-off contract: a spark at
  rest with all knobs 0 must be untouched, and hoisting aero above the sleep gate
  risks perturbing the resting set. The T9 control "aero outside the moving block"
  proves the hazard: lifting the block above the sleep check DOES wake a resting
  spark, so the gate is load-bearing and the block stays inside. Resting embers
  stay put; only sparks already in flight feel the air.
- **Three separate config gates / three per-particle branches.** Rejected: three
  independent `if`s in the hottest loop, each paid by every spark every frame.
  One `aero` disjunction hoisted to the preheader collapses them to a single
  branch that is false at the default.
- **A per-spark turbulence-phase column.** Rejected: a new Float32Array column,
  a new spawn write, and a new backing store to pin -- all to store a value
  `invLife` already provides. Reusing `invLife * TURB_K` is free.
- **Per-particle `Math.sin` for gust.** Rejected: the gust field is uniform
  across the frame, so sampling it once in the preheader (`gustNow`) is correct
  and moves `sin` off the hot path. A per-spark sin would be thousands of
  transcendental calls per frame for a value that does not vary per spark.
