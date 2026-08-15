# 0007 -- `drag` is an alias for `friction`, not a second knob; terminal velocity is emergent

- Status: accepted
- Date: 2026-08-15
- Session: S4 (v1.3.0)
- Finding: S-13

## Context

The S4 "air" wave adds wind, gust, and turbulence -- air that pushes sparks
around. The obvious next request is "air that slows sparks down": drag. But the
engine already HAS an air-resistance term. Since v1.1.0 (S-04) friction is a
dt-independent retention factor applied every frame:

```js
const f = Math.pow(cfg.friction, dt * 60);   // hoisted once
this.vx[i] *= f;
this.vy[i] *= f;
```

That IS linear drag. Retaining `friction` of the velocity each 1/60s frame is
exactly a velocity-proportional resistance. With gravity feeding vy in and
friction bleeding it out, the balance point -- `gravity * dt == vy * (1 - f)` --
is a terminal velocity the spark asymptotes to. It is already emergent; nothing
in the hot loop needs to change to get it.

The problem is only the NAME. `friction` reads as "floor friction" to a caller
skimming the config, and the separate `floorFriction` key makes the collision
worse. A caller who wants "more air resistance" looks for a key called `drag`,
does not find one, and either gives up or (worse) cranks `floorFriction`, which
does nothing in mid-air.

## Decision

Add a `drag` config key that is a pure **cold-path alias** for `friction`. When
provided (`!= null`), it overrides `friction` at construction:

```js
drag: null,          // default in the config block
// ...
if (this.config.drag != null) this.config.friction = this.config.drag;
```

`friction` stays the one and only hot-path air-resistance knob. `drag` never
reaches the hot loop -- it is resolved once in the constructor into `friction`,
and the per-particle body keeps its single `vx *= f` / `vy *= f`. No new hot
read, no new branch, no new column. Terminal velocity remains emergent from the
gravity/friction balance; `drag` just gives that balance a discoverable name.

`null` is the default sentinel, not `0` (the suite's fail-closed law: null is not
zero). `drag: 0` is a MEANINGFUL value -- retention factor 0, i.e. total drag,
velocity zeroed every frame -- so it must be honoured, not treated as "unset".
Only `null`/`undefined` mean "caller did not set drag, keep the friction
default". `this.config.drag != null` is exactly that test (`!=` catches both
`null` and `undefined`, nothing else).

## Consequences

- One cold `if` in the constructor. Zero hot-path change; zero new allocation.
  The aero-off hot body stays byte-identical to v1.2.0.
- `drag` and `friction` are the same underlying number. Passing both is not an
  error -- `drag` simply wins (it is applied after the spread). Documented.
- Terminal velocity is not a config key. It is the fixed point of the existing
  gravity-in / friction-out loop and moves when either `gravity` or
  `friction`/`drag` moves. Exposing it as a settable target would require solving
  for the friction that yields it -- cold arithmetic we deliberately do not add,
  because the two primitives already compose to it.

## Rejected alternatives

- **A separate `drag` term added to the hot loop (`v -= v * drag * dt`).**
  Rejected: it duplicates what `friction` already does, adds a second per-particle
  multiply-subtract to the hottest path, and creates two knobs that fight over the
  same physical quantity. Bytes in the hot body for a term we already have.
- **Rename `friction` to `drag` outright.** Rejected: `friction` is public API
  since v1.0.0 and load-bearing in decisions/0004 and every torture tier. A rename
  is a breaking change for a cosmetic gain; an alias costs one cold `if`.
- **A settable `terminalVelocity` key.** Rejected: terminal velocity is emergent
  from gravity and friction; making it an input means back-solving for friction
  each time either changes, and desyncs the moment a caller sets `gravity`
  directly. The balance is better left as the composed behaviour of two
  primitives.
