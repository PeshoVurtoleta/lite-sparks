# 0009 -- Walls are one hoisted `if (walls)` clamp inside the moving gate; a wall never wakes a resting ember

- Status: accepted
- Date: 2026-08-15
- Session: S4b (v1.3.1)
- Finding: S-14

## Context

The S4b "containment" wave adds boundaries: a left wall, a right wall, and a
ceiling that keep sparks inside a region instead of letting them fly off and
X-cull. Three effects were asked for:

- **wallLeft / wallRight** -- vertical boundaries a spark bounces off in x.
- **ceiling** -- a horizontal boundary a spark bounces off in y (there is no
  floor wall here; the existing floor restitution already owns the bottom).

The hard constraint is the same one the air wave (ADR 0008) lived under: this
engine's identity is a zero-GC, byte-stable per-particle loop, and the default
(all-off) body must stay byte-identical to v1.2.0. A boundary must NOT become
three new per-particle branches every spark pays every frame, and it must not
perturb the resting set.

## Decision

One cold preheader hoist, one hot gate. The per-particle body gains exactly one
`if (walls)`; everything else is cold.

### One preheader hoist, one gate

```js
const wallLeft = cfg.wallLeft;
const wallRight = cfg.wallRight;
const ceiling = cfg.ceiling;
const walls = wallLeft != null || wallRight != null || ceiling != null;
```

`walls` is the single hot-loop gate. When all three bounds are `null`, `walls` is
`false` and the clamp below is skipped entirely, so the per-particle body is the
v1.2.0 body, byte-for-byte. `null` is the "no wall" sentinel, distinct from `0`
(null is not zero): a wall AT `0` is a real, honoured left/top edge.

### One hot block, AFTER the floor test, INSIDE the moving gate

```js
if (walls) {
    if (wallLeft != null && xs[i] < wallLeft)  { xs[i] = wallLeft;  if (vxs[i] < 0) vxs[i] = -vxs[i]; }
    if (wallRight != null && xs[i] > wallRight){ xs[i] = wallRight; if (vxs[i] > 0) vxs[i] = -vxs[i]; }
    if (ceiling != null && ys[i] < ceiling)    { ys[i] = ceiling;   if (vys[i] < 0) vys[i] = -vys[i]; }
}
```

Two placement decisions are load-bearing:

1. **After the floor block.** The floor restitution may have just moved a spark's
   y and zeroed its velocity; the wall clamp reads the post-floor position so a
   floor-rested spark's clamp wins and the two containment surfaces compose
   cleanly.

2. **After position integration.** `xs[i] += vxs[i]*dt` and `ys[i] += vys[i]*dt`
   run earlier in the moving block. Clamping AFTER integration means a spark that
   crossed a wall THIS frame is pulled back onto it and its inward velocity
   reflected out. Clamping BEFORE integration would let the spark step straight
   through the wall in the same frame -- it ends up outside and drifts on to
   X-cull. The T9 control D proves this: the broken clamp-before-integrate order
   leaves the spark past the wall, so the order is not cosmetic.

The sign test on the reflection (`if (vxs[i] < 0)`) avoids re-flipping a spark
that is already moving away from the wall -- a spark pinned on a wall with an
outward velocity keeps it.

### Walls never wake a resting ember

The whole `if (walls)` block lives INSIDE the existing `if (vxs[i] !== 0 ||
vys[i] !== 0)` moving gate (S-05 sleep optimisation). A resting spark
(vx==vy==0) bypasses all physics, so a wall never yanks it onto a boundary --
exactly the "wind does not wake resting embers" contract from ADR 0008, applied
to boundaries. A resting ember placed outside a wall stays where it rests; only
sparks already in flight are contained. The T9 control and the node:test
"walls never wake a resting ember" case pin this.

### Non-finite bounds fail closed (sanitized once, in the cold constructor)

A wall is a plain `!= null` gate, so a non-finite bound would switch `walls` ON
and feed a comparison against `NaN`/`Infinity`. `Number.isFinite(null)` is
`false`, so the same coercion collapses "unset" and "hostile" into `null`:

```js
if (!Number.isFinite(this.config.wallLeft))  this.config.wallLeft  = null;
if (!Number.isFinite(this.config.wallRight)) this.config.wallRight = null;
if (!Number.isFinite(this.config.ceiling))   this.config.ceiling   = null;
```

A wall AT `0` is finite, so it survives -- null is not zero. Only non-finite
bounds become "no wall". Cold, constructor-only, zero hot bytes.

## Consequences

- Per-particle cost when walls are off: one `if (walls)` that is false -- the body
  is byte-identical to v1.2.0. The default seeded run stays Object.is-identical
  and the render fingerprint is unchanged (torture T0 laws 6 + 10-11).
- Per-particle cost when walls are on: at most three compares and, on a crossing,
  one assignment + one negate. Zero allocation.
- **Wall-contained sparks never X-cull.** A boundary that keeps a spark on-screen
  removes the X-cull as a drain path, so the pool now drains ONLY by life expiry
  and S-08 ring eviction. The soak (torture T7) MUST cover walls-on to prove a
  contained pool still returns to empty every cycle; it does (life bounds Y and
  the ring evicts under sustained pressure).
- One cold gate, three cold config reads per frame. No new SoA column, no new
  buffer to pin (torture T6 walls lane pins all 12 backing stores unchanged).

## Rejected alternatives

- **Clamp BEFORE integration.** REJECTED. Clamping the pre-move position lets a
  spark step through the wall the same frame it crosses, so it is never actually
  contained -- it escapes and X-culls. The T9 control D replays both orders and
  shows the before-order leaves the spark outside the wall. Placement after
  integration is the whole point.
- **Waking resting embers so a wall "shoves" a pile.** REJECTED for the same two
  reasons ADR 0008 rejected wind-wakes-sleepers: it is a hot-path cost with no
  gate (every resting spark would pay the wall branch), and it perturbs the
  resting set that the aero-off/containment-off contract freezes.
- **A fourth `floorWall` key.** REJECTED. The bottom is already owned by the
  floor restitution (S-10 `floorY`), which does energy-losing bounce + rest, a
  richer behaviour than a pure reflect. A second bottom boundary would fight it.
- **Three independent config gates / three per-particle branches.** REJECTED, as
  in ADR 0008: three `if`s in the hottest loop paid by every spark. One `walls`
  disjunction hoisted to the preheader collapses them to a single branch that is
  false at the default.
