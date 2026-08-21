# 0012 -- onBounce is one guarded call inside the floor branch; primitives only, no try/catch, no mid-frame mutation

- Status: accepted
- Date: 2026-08-21
- Session: S5 (v1.4.0)
- Finding: S-15

## Context

The S5 wave asks for a floor-contact hook: a way for a caller to react when a
spark lands -- play a tick sound, spawn a scorch decal, count impacts. The hook
must fire on the bounce, carry enough about the impact to be useful, and gate on
impact strength so a spark gently settling on the floor every frame does not fire
a machine-gun of callbacks.

The hard constraint is the engine's identity: a zero-GC, byte-stable per-particle
loop whose default (all-off) body is byte-identical to v1.3.1. A hook must not
become a per-particle cost every spark pays every frame, must not allocate, and
must not open a door for caller code to poison or stall the frame.

## Decision

One config key `onBounce` (a function or `null`) plus a threshold
`onBounceMinSpeed`, hoisted to the preheader and called from exactly one place --
inside the EXISTING floor branch, which already only runs when a spark contacts
the floor.

### Capture the pre-bounce speed, then one guarded call

```js
if (ys[i] > floorY) {
    ys[i] = floorY;
    const pvy = vys[i];          // PRE-bounce downward speed (positive = falling)
    vys[i] *= -restitution;
    vxs[i] *= floorFriction;
    if (Math.abs(vys[i]) < 20) vys[i] = 0;
    if (vys[i] === 0 && Math.abs(vxs[i]) < 5) vxs[i] = 0;
    if (onBounce !== null && pvy > obMin) onBounce(xs[i], vxs[i], weightA[i]);
}
```

`pvy` is captured BEFORE restitution flips the sign, so the threshold gates on the
speed at which the spark actually hit the floor -- a fast impact fires, a spark
that has come to rest and grazes the floor (small `pvy`) does not. The hook
receives the position, the POST-bounce horizontal velocity (the direction debris
would scatter), and the spark's weight, all primitives.

### Where the guard lives -- and why it is byte-identical at the default

The `if (onBounce !== null ...)` sits inside the floor branch, which is itself
inside the S-05 moving gate -- the coldest reachable spot that still sees a
bounce. `onBounce` defaults to `null`, so the guard is `false` and the call never
runs; the only added byte on the default path is the `const pvy = vys[i]` capture
and a dead compare, neither of which touches physics output. The committed
AERO_OFF_HASH (`2975953379`) and all seven other fingerprints are unchanged.

### Primitives only

The hook is called with three numbers, never the SoA arrays or an index the
caller could use to reach into the pool. This keeps the contract narrow (a caller
cannot corrupt a neighbour's slot) and keeps the call zero-allocation: no wrapper
object, no `{x, y, ...}` event is built per bounce.

### No try/catch -- a throw MUST surface

There is deliberately no `try/catch` around the call. A hook that throws is a bug
in CALLER code, and swallowing it would hide that bug while leaving the frame
half-rendered and the pool in an indeterminate mid-loop state. Fail closed here
means fail LOUD: the throw propagates out of `updateAndDraw` so the caller sees
it at the frame that caused it. Wrapping every bounce in a `try/catch` would also
add hot-path bytes (the handler frame) for a case that should never happen. The
contract is explicit: the hook must not throw and must not mutate the engine
mid-frame (e.g. call `burst`/`clear`/`destroy` from inside the loop, which would
race the very arrays being iterated). The T9 throwing-onBounce control proves the
throw surfaces -- i.e. that we do NOT catch it.

### Fail closed on the config door

A non-function `onBounce` (including `undefined`) coerces to `null` once in the
cold constructor, so the hot guard is a plain `!== null` and never has to
typecheck. A non-finite `onBounceMinSpeed` coerces to `0`. Cold, constructor-only,
zero hot bytes.

## Consequences

- Per-particle cost when the hook is off: the `pvy` capture and a dead `!== null`
  compare, only on a frame where a spark actually contacts the floor. No cost on
  a spark in free flight or at rest. Byte-identical output at the default.
- Per-particle cost when on: one compare + one call on a qualifying bounce, with
  three primitive arguments. Zero allocation.
- The threshold makes the hook usable: a settling pile does not fire it every
  frame, only real impacts above `onBounceMinSpeed` do.
- A throwing or engine-mutating hook is the caller's contract violation; the
  engine does not defend against it (no try/catch), so the failure is visible at
  its source (torture T9 surfaces the throw).

## Rejected alternatives

- **A try/catch around the hook.** REJECTED. It hides caller bugs, leaves the
  frame in an indeterminate state, and adds hot-path bytes for a should-never
  case. A thrown hook is a loud failure by design.
- **Passing the spark index or the SoA arrays to the hook.** REJECTED. It widens
  the contract to "the caller may reach into the pool mid-loop" -- a foot-gun that
  invites the exact mid-frame mutation the contract forbids -- and it tempts a
  wrapper-object allocation. Three primitives are enough for sound/decal/count.
- **Firing on every floor contact (no threshold).** REJECTED. A spark rests on
  the floor by contacting it every frame; an un-gated hook would fire a callback
  storm for a pile at rest. `onBounceMinSpeed` on the pre-bounce speed fires only
  on real impacts.
- **A hot-path `if (onBounce)` at the top of the per-particle body.** REJECTED as
  a per-particle cost every spark pays every frame. The floor branch already
  isolates the only place a bounce can happen; the guard belongs there.
