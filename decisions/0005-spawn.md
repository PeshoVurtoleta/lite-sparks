# 0005 -- Spawn is a ring cursor (overwrite-oldest), not a free-slot scan

- Status: accepted
- Date: 2026-08-15
- Session: S3 (v1.2.0)
- Finding: S-08

## Context

Through v1.1.0 `burst` found slots by scanning the pool from index 0 and taking
the first dead slot for each spark:

```js
for (let i = 0; i < this.max; i++) {
    if (this.state[i] === 0) {
        // ...spawn into slot i...
        if (++spawned >= count) return;
    }
}
```

This is O(max) per burst regardless of how many sparks are spawned. On a mostly
full pool (the steady-state case for a sustained emitter) every burst walks past
hundreds of live slots to find a handful of dead ones, and a burst into a *full*
pool walks the entire pool and spawns nothing. Cost scales with pool size, not
with work. The README already advertised "ring buffer" behavior the code did not
implement.

## Decision

Replace the from-zero scan with a **ring cursor** that advances one slot per
spark and overwrites whatever is there -- confetti's `head = (head + 1) % max`,
**overwrite-oldest**:

```js
let head = this._head;
for (let s = 0; s < count; s++) {
    head = head + 1;
    if (head >= max) head = 0;   // power-of-2-free modulo; max is caller-chosen
    // spawn into slot `head`, alive or dead
}
this._head = head;
```

`count` is first floored by the existing S-02 door and then **capped at `max`**:
the pool holds at most `max` live sparks, so a burst larger than the pool can
only ever fill the pool. The cap keeps the loop O(min(count, max)) instead of
letting a hostile `count = 1e6` spin a million times overwriting its own fresh
sparks.

### The liveness question -- overwrite-oldest, no skip

The roadmap floated a "liveness skip": prefer a dead slot, fall back to eviction.
Rejected in favor of the simpler, stricter policy: **the cursor never checks
liveness. If it lands on a still-alive spark, it overwrites it.** Two reasons:

1. **O(1) per spawn, no scan.** A skip that prefers dead slots reintroduces a
   scan (bounded or not) and, worse, on a full pool a single-slot skip advances
   the cursor by two per spawn -- so a `burst(max)` into a full pool touches only
   *half* the slots (every other one), leaving the other half holding stale
   sparks. "Spawn 2000 fresh sparks" would then leave 1000 stale ones live. Pure
   overwrite-oldest advances exactly one slot per spawn, so `burst(max)` visits
   every slot exactly once and the pool ends holding `max` fresh sparks.

2. **Oldest-first is the right eviction order.** Because the cursor advances
   monotonically, the slot it overwrites is always the one written longest ago --
   the oldest spark, the one closest to dying anyway. Evicting it is visually the
   least disruptive choice, and it is exactly what a fixed-capacity debris buffer
   wants under sustained pressure.

The tradeoff is explicit and accepted: **under pressure a burst can evict a
still-live spark.** For a debris engine with a bounded pool this is correct --
the alternative (silently dropping the new spark, as a free-slot-only policy
would once the pool fills) is worse, because the *newest* impact is the one the
caller most wants to see.

### Conservation law, restated

The old metamorphic law was `aliveCount == min(count, freeSlots)`. Overwrite-
oldest makes it `aliveCount == min(count, max)`: a burst can reuse live slots, so
the ceiling is the pool size, not the free count. Torture T0 law 1 is updated to
the `min(count, max)` form; its numeric assertions (empty pool -> `count`,
over-capacity -> `max`) are unchanged because they never exercised the
free-vs-max gap.

## Consequences

- `burst` is O(count) (capped at O(max)) instead of O(max) unconditionally. A
  sustained emitter into a near-full pool no longer pays for the dead slots it
  skips.
- Slot *assignment* differs from v1.1.0 (the cursor starts at index 1, not 0, and
  wraps), so a per-slot snapshot is not comparable across versions. The *multiset*
  of spawned sparks is identical: `burst` draws the same rng values in the same
  order, so any order-independent fingerprint (the position hash) is unchanged for
  a capacity-respecting script.
- Under sustained over-capacity emission the oldest live spark can be evicted a
  frame or two before it would have died. Bounded, deterministic, documented.
- `_head` persists across bursts and across `clear()` (a cleared pool keeps
  cycling from where it was); `destroy()` does not touch it.

## Rejected alternatives

- **Free-slot ring with a bounded liveness skip.** Rejected: on a full pool a
  single skip advances two slots per spawn, so `burst(max)` covers only half the
  pool and leaves stale sparks live -- "spawn N" would not spawn N. The extra
  branch also buys nothing on a sparse pool, where the very next slot is almost
  always the oldest-and-dead one anyway.
- **Free-slot-only (drop the burst when full).** Rejected: silently dropping the
  newest impact is the worst failure mode for an impact/debris engine -- the new
  spark is the one the caller asked for.
- **Keep the O(max) scan, add a live-count short-circuit.** Rejected: still O(max)
  in the full-pool steady state that matters, and does not make the "ring buffer"
  claim true.
