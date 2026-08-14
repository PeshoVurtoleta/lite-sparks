# 0002 -- `burst` spawns exactly `min(count, freeSlots)`; `life` is clamped at spawn

- Status: accepted
- Date: 2026-08-15
- Session: S1 (v1.0.2)
- Findings: S-02 (count door + off-by-one), S-11 (`life=0`)

## Context (S-02)

`burst(x, y, count, ...)` is reachable from ordinary caller code (one per impact,
dozens per welding/grinding frame) with `count` derived from user data. v1.0.1
did not validate it, and the pool-fill guard was a **post-increment**:

```js
if (++spawned >= count) return;   // runs AFTER a spawn has already happened
```

So the first slot is always written before the guard is tested. Consequences:

- `count = 0` -> spawns **1** (`1 >= 0` is true, but only after slot 0 is filled).
- `count = -5` -> spawns **1** (`1 >= -5` is true, same reason).
- `count = NaN` / `Infinity` -> **fills the whole pool** (`n >= NaN` is always
  `false`, so the guard never fires and the loop runs to `this.max`).
- `count = 1.5` -> spawns **2** (`1 >= 1.5` false, `2 >= 1.5` true).

"Spawn something anyway" is not a policy. Null is not zero.

## Decision (S-02)

Sanitize at the top of `burst`, in the cold path, before the loop:

```js
count = count >= 1 ? (count | 0) : 0;
if (count === 0) return;
```

- `count | 0` floors toward zero (`1.5 -> 1`) and is `0` for `NaN`/`Infinity`,
  but only after the `>= 1` gate has already rejected everything below 1, so the
  `| 0` never has to represent a non-finite value.
- `count >= 1` is `false` for `0`, negatives, `NaN`, and `-0`, mapping all of
  them to `0`; the early `return` makes a hostile count a no-op.

### The off-by-one is left as-is on purpose

Once `count >= 1` is guaranteed, the existing post-increment guard is **correct**:

```js
if (++spawned >= count) return;
```

- `count = N` on an empty pool of `N`: slot 0..N-1 each spawn; after the Nth
  spawn `spawned === N >= N` returns. Fills exactly `N`.
- `count = N + 1` on a pool of `N`: only `N` free slots exist; the loop reaches
  `i === this.max` and exits naturally having spawned `N`.
- `count = 5` into a pool with 3 free: spawns 3, loop exhausts, returns.

So the **contract is `burst` spawns exactly `min(count, freeSlots)`** for every
`count >= 1`, and 0 for any hostile count. No restructuring of the guard is
needed; the door in front of it is what was missing.

## Context + Decision (S-11)

If `lifeMin` and `lifeMax` are both `0` (or `lifeMin > lifeMax` yields a negative
draw), the spawned `life` is `<= 0`, so `invLife = 1 / life` is `Infinity` (or a
huge/negative number) and `colorIdx = floor(life * invLife * len)` degrades to
`NaN` -> `colors[NaN]` -> `strokeStyle = undefined`. Latent in v1.0.1 only
because a `life <= 0` spark is culled on its first update, but the
division-by-zero and the `undefined` strokeStyle are unpinned.

**Clamp, do not skip.** At spawn:

```js
let life = lifeMin + this.config.rng() * (lifeMax - lifeMin);
if (life < 1e-4) life = 1e-4;
this.life[i] = life;
this.invLife[i] = 1.0 / life;
```

`1e-4` keeps `invLife` finite (`1e4`) and `colorIdx` a valid index. The `< 1e-4`
test also clamps a tiny positive `life` up, bounding `invLife` regardless of
sign, and catches an inverted `lifeMin > lifeMax`.

### Why clamp, not skip the spawn

Skipping would make `burst`'s spawn count depend on the *value* of a random draw,
breaking the `min(count, freeSlots)` contract above and the seeded-determinism
law (two engines with the same seed could spawn different counts if the RNG were
ever changed to allow `life <= 0` conditionally). Clamping keeps the count
contract exact and the spawn deterministic: a caller asking for a zero-life spark
gets a `1e-4`-life spark that is culled on the next update, which is
indistinguishable in output from the pre-fix behavior but never touches
`Infinity`/`NaN`.

## Consequences

- `burst` `count` in `{0, -5, NaN, Infinity}` -> 0 alive; `1.5` -> 1; valid
  count -> `min(count, freeSlots)`. Pinned by name in torture T1 and
  `test/boundary.test.js`.
- `burst(...,lifeMin=0,lifeMax=0)` never produces `Infinity` in `invLife` or
  `NaN` in `colorIdx`.
- Both changes are cold-path (function entry and spawn). The per-particle
  physics/render loop body is byte-identical to v1.0.1.
