# Changelog

All notable changes to `@zakkster/lite-sparks` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-08-15

The hostile-input doors (roadmap session S1). Two silent whole-engine
corruptions reachable from a single ordinary call are closed at the cold path;
the per-particle physics/render loop body is byte-identical to 1.0.1 (comment
text only -- the non-ASCII cleanup below). No new config keys, no new ops.

### Fixed

- **S-01** (`dt` door). A single non-finite or non-positive `dt` no longer
  poisons every live particle to NaN. The fail-open `if (dt > 0.1) dt = 0.1`
  clamp (false for NaN, `-0`, `0`, negatives) is now preceded at the top of
  `updateAndDraw` by `if (!(dt > 0)) return;`. A bad `dt` is a silent no-op frame
  that leaves the last good state on screen (fail closed). Before:
  `updateAndDraw(ctx, NaN, 800, 600)` set `x[0]`/`life[0]` to NaN and every
  subsequent frame stayed poisoned. After: no-op, `aliveFinite` holds.
  Rationale in `decisions/0001-hostile-dt.md`.
- **S-02** (`burst` count door + off-by-one). `burst(count)` is now sanitized at
  entry: `count = count >= 1 ? (count | 0) : 0; if (count === 0) return;`. Before:
  `count=0` and `count=-5` spawned 1 (post-increment `++spawned >= count`),
  `count=NaN`/`Infinity` filled the whole pool (`n >= NaN` is always false), and
  `count=1.5` spawned 2. After: `0`/`-5`/`NaN`/`Infinity` spawn 0, `1.5` spawns 1,
  and a valid count spawns exactly `min(count, freeSlots)`. The existing
  `if (++spawned >= count) return;` is correct for `count >= 1` (an exhausted pool
  exits the loop naturally). Contract in `decisions/0002-burst-count.md`.
- **S-11** (`life=0` spawn). A computed `life <= 0` is clamped to `1e-4` at spawn,
  so `invLife = 1/life` is never `Infinity` and `colorIdx` is never `NaN`. Before:
  `burst(...,lifeMin=0,lifeMax=0)` wrote `invLife = Infinity` (latent, masked by
  the first-frame cull). Also catches an inverted `lifeMin > lifeMax`. Decided in
  `decisions/0002-burst-count.md`.

### Changed

- `SparkEngine.js` source is ASCII-only per the suite Law: the 5x `U+26A1` and
  1x `U+2014` in comments are replaced with `->` / `--`. Comments only; no logic
  change. Stale `v1.0.0` in the header docblock corrected to `v1.0.2`.
- `VERSION` const and `package.json` bumped to `1.0.2` (three-place sync).
- Torture T1 flips the S-01/S-02 pins from the buggy v1.0.1 behavior to the fixed
  answers, and adds the `1e-45` subnormal `dt` case plus `w`/`h` in {0,-1,NaN}.
  T0 adds the S-01 quarantine law (10k good + 1 poison + 10k good == a
  never-poisoned run). T9 adds a control proving the `dt` door is load-bearing (a
  NaN that bypasses the door fails `aliveFinite`). `test/boundary.test.js` anchors
  now assert the fixed behavior.

## [1.0.1] - 2026-08-15

Test-infrastructure and metadata release. No engine behavior changes: the
physics and render paths are byte-identical to 1.0.0 apart from a new `VERSION`
export.

### Added

- `VERSION` const exported from `SparkEngine.js` (three-place version sync:
  `package.json`, the `VERSION` const, `llms.txt`).
- `test/torture.mjs` + `test/torture/` -- a sequential torture gate cloned from
  `lite-bvh`, run with `node --expose-gc test/torture.mjs` (prints `ok`, exit 0).
  Tiers: T0 metamorphic laws (burst conservation, seeded determinism), T1
  degenerate hostile `dt`/`count` (pins the current buggy behavior as executable
  reproductions), T5 (empty stub, filled in S3), T6 zero-alloc gate over a
  full-pool emission + render scene with all eight SoA `buffer.byteLength` pins,
  T7 4096-cycle soak with a `@zakkster/lite-leak` second witness, T9 controls
  (each gate proven able to fail; `SPARKS_TORTURE_BREAK=1` fails the whole suite).
- `aliveCount(engine)` / `aliveFinite(engine)` structural pool invariants (the
  S-01/S-02 detectors) in the harness.
- `npm run torture` and `npm run verify` scripts; `CHANGELOG.md`.

### Changed

- Test runner ported from `vitest` to `node:test` + `node:assert/strict`. All 13
  cases retained. `"test"` is now `node --expose-gc --test test/*.test.js`.
- `engines.node` set to `>=18`. `sideEffects: false` declared.
- `CHANGELOG.md` added to `package.json` `files[]`.

### Removed

- `vitest` devDependency and `vitest.config.js`.
- The inaccurate `"webgl"` keyword (this is a Canvas2D engine).

### Known issues

Reproduced against 1.0.0 on 2026-08-15, Node 26. Registered as pinned torture
cases here (T0/T1) and fixed in the sessions noted. Nothing below is fixed in
1.0.1 -- this release only makes them visible and reproducible.

- **S-01** (S1, fix in S1): a single non-finite `dt` poisons every live particle
  to NaN, permanently and silently -- the `if (dt > 0.1) dt = 0.1` clamp is
  fail-open (false for NaN and negatives). Repro:
  `burst(400,300,1,0,0,100,100); updateAndDraw(ctx, NaN, 800, 600)` -> `x[0]`,
  `life[0]` become NaN. (T1 pins `aliveFinite === false` for `dt` in {NaN, -Inf}.)
- **S-02** (S1, fix in S1): `burst(count)` is unvalidated and the guard is a
  post-increment `++spawned >= count`. `count=0` spawns 1, `count=-5` spawns 1,
  `count=NaN`/`Infinity` fill the whole pool, `count=1.5` spawns 2. Repro:
  `burst(x,y,0,...)` -> 1 alive; `burst(x,y,NaN,...)` -> `max` alive. (T1 pins.)
- **S-03** (S2, fix in S2): unconditional full-canvas `clearRect` every frame in
  both modes -- sparks cannot layer over a game/scratch surface. `updateAndDraw`
  calls `ctx.clearRect(0,0,w,h)` before the mode branch.
- **S-04** (S2, fix in S2): frame-rate-dependent friction (`v *= friction` per
  frame). ~28px divergence over 1s between 30fps and 120fps.
- **S-05** (S2, fix in S2): zero-velocity sparks hang mid-air forever -- the
  sleep check bypasses gravity when `vx===0 && vy===0`. Repro:
  `burst(400,100,1,0,0,0,0,5,5)` -> `y` stays 100 for 30 frames.
- **S-06** (S2, fix in S2): cull is X-only, exact-edge, one frame stale -- the
  stretched tail pops out before it clears the edge. No leak class (life bounds).
- **S-07** (S3, fix in S3): unbatched rendering -- per-particle
  `beginPath`/`lineWidth`/`strokeStyle`/`stroke`.
- **S-08** (S3, fix in S3): O(max) from-zero free-slot scan in `burst` every
  call, despite the README's "ring buffer" claim.
- **S-09** (S3, fix in S3): loop-invariant property loads
  (`config.gravity/friction/stretch`, `colors`, array refs) re-read per particle
  per frame.
- **S-10** (S2, fix in S2): floor hardcoded to `h`; no `floorY` config.
- **S-11** (S1, fix in S1): `life=0` spawn -> `invLife = 1/0 = Infinity` ->
  `colorIdx = NaN` -> `strokeStyle = undefined`. Latent (masked by first-frame
  cull today). Repro: `burst(...,lifeMin=0,lifeMax=0)` then inspect `invLife`.

## [1.0.0]

- Initial release: zero-GC, SoA spark and debris engine with vector velocity
  stretching, floor restitution, and a precomputed OKLCH heat gradient.
