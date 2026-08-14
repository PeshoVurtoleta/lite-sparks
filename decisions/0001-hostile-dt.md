# 0001 -- A hostile `dt` is a silent no-op frame, not a throw

- Status: accepted
- Date: 2026-08-15
- Session: S1 (v1.0.2)
- Finding: S-01

## Context

`updateAndDraw(ctx, dt, w, h)` takes `dt` from `performance.now()` deltas the
engine does not control: a backgrounded tab, a paused debugger, a bad system
clock, a first frame before a baseline timestamp exists. Those produce `dt`
values of `NaN`, `-0`, `0`, negatives, subnormals (`1e-45`), and huge finites.

The only guard in v1.0.1 was `if (dt > 0.1) dt = 0.1;`. That comparison is
**fail-open**: it is `false` for `NaN`, `-0`, `0`, and every negative, so all of
them reach the physics loop. `vy[i] += gravity * NaN -> NaN` propagates to
`x/y/vx/vy/life` for every live spark; a negative `dt` runs physics backward.
Once a column is `NaN` it never satisfies the life/x cull cleanly, so every
later frame keeps it `NaN` -- the emitter looks dead with no signal. This is the
same silent whole-engine corruption class as bvh B-03 / arena AR-01.

## Decision

At the very top of `updateAndDraw`, before the existing clamp:

```js
if (!(dt > 0)) return;   // rejects NaN, -0, 0, negatives -> no-op frame
if (dt > 0.1) dt = 0.1;  // existing tab-backgrounding teleportation guard
```

`!(dt > 0)` is the fail-closed form: it is `true` for `NaN` (any comparison with
`NaN` is `false`, so `!false` is `true`), for `-0` and `0` (`0 > 0` is `false`),
and for negatives. Only a strictly-positive finite or `+Infinity` passes, and
`+Infinity` is immediately clamped to `0.1` by the next line. A bad frame is a
**no-op**: the loop never runs, nothing is drawn or culled, the last good SoA
state is left intact.

### Why a no-op, not a throw

This is a render loop, called once per animation frame from code the engine does
not own (a RAF callback, a game tick). The correct failure mode for a render
loop fed one bad timestamp is to **skip that frame and keep the last good
image**, exactly as a video player drops a corrupt frame rather than crashing
the player. A throw would:

- turn a single transient bad clock reading into an uncaught exception that tears
  down the host's RAF loop (the whole animation dies for one bad `dt`);
- force every caller to wrap `updateAndDraw` in try/catch on the hot path;
- violate "fail closed" in spirit -- a throw is louder but it does not *preserve*
  the last good state, it destroys the caller's frame budget.

A no-op leaves the engine in a valid state (`aliveFinite` holds) and the next
good `dt` resumes physics seamlessly. That is the fail-closed choice here: the
unverified input is rejected and the last verified state is retained.

## Consequences

- `dt` in `{0, -0, -1, NaN, +Infinity, -Infinity, 1e-45, 1e9}` all leave every
  live particle finite. Pinned by name in torture T1.
- The S-01 quarantine holds: 10k good frames + one poison-dt frame + 10k more
  produces a snapshot byte-identical to a never-poisoned run (torture T0).
- The guard is one comparison at function entry (cold path). The per-particle
  physics/render loop body is byte-identical to v1.0.1 -- no hot-path cost.
- Trade-off: a legitimately huge-but-finite `dt` (e.g. the first frame after a
  long stall) is clamped to `0.1`, so animation resumes from the last position
  rather than teleporting. This is the intended tab-backgrounding behavior and
  predates S1.

## Rejected alternatives

- **Throw on bad `dt`.** Rejected above: kills the caller's loop, no state
  preservation benefit.
- **Clamp `dt` to a floor (`Math.max(dt, 0)` or an epsilon).** Rejected: a `0`
  or `NaN` clamped to an epsilon still runs a physics step with no real time
  elapsed, advancing gravity and consuming life for a frame that never happened.
  A no-op is more honest.
