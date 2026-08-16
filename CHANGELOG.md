# Changelog

All notable changes to `@zakkster/lite-sparks` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-08-15

Containment (roadmap session S4b, the walls + vortex wave). Sparks can now be
bounded and swirled: three optional walls (`wallLeft`, `wallRight`, `ceiling`)
reflect a moving spark's velocity and clamp its position, and a vortex
(`attract` radial pull + `swirl` tangential push toward `attractX`/`attractY`)
folds into the existing air-force branch. The hot path grows exactly one new
`if (walls)` clamp after the floor block plus the vortex accel inside the single
`if (aero)` gate -- both dead (byte-identical to v1.2.0) at the default, where
every wall is null and every vortex scalar is 0. Proven: the aero-off /
containment-off render fingerprint is unchanged (`2975953379`), and a default
seeded run's x/y/vx/vy/life/state snapshot is Object.is-identical to v1.2.0. Zero
new allocation and zero new SoA column.

### Added

- **S-14** walls. Three cold config keys -- `wallLeft`, `wallRight`, `ceiling`
  (all default `null`, "no wall"; null is not zero, so a wall AT 0 is honoured).
  A moving spark is clamped to the bound and its inward velocity reflected (vx at
  the side walls, vy at the ceiling), in one hoisted `if (walls)` placed AFTER the
  floor block and INSIDE the S-05 moving gate -- walls never wake a resting ember
  (mirror of "wind does not wake resting embers", ADR 0008). Rationale in
  `decisions/0009-walls.md`.
- **S-14** vortex. Four cold config keys -- `attract` (radial pull toward the
  center, negative repels), `swirl` (a perpendicular tangential push), and
  `attractX`/`attractY` (the center, read only when the vortex is live; default
  0). The accel is normalized by distance (dist===0 is skipped -- fail closed, no
  divide-by-zero) and clamped per-axis to `+/-VORTEX_MAX_ACCEL` (4000, 5x the
  default gravity), then folded into the existing `if (aero)` disjunction
  (`aero = wind!==0 || gustNow!==0 || turb!==0 || attract!==0 || swirl!==0`) --
  no new per-particle gate. Rationale in `decisions/0010-vortex.md`.

### Changed

- **S-14** fail-closed containment knobs. A non-finite `wallLeft`/`wallRight`/
  `ceiling` is coerced to `null` (no wall), and a non-finite `attract`/`swirl`/
  `attractX`/`attractY` to `0` (off), ONCE in the cold constructor -- a hostile
  config can never NaN the pool through the vortex gate the way a non-finite air
  knob would (the S-01 whole-pool poison class, ADR 0008). Zero hot bytes.

## [1.3.0] - 2026-08-15

Air (roadmap session S4, the aerodynamics wave). Sparks now respond to moving
air: a constant `wind`, an oscillating `gust`, and a per-spark `turbulence` curl.
The whole feature is one hoisted `if (aero)` inside the existing moving block --
when every knob is 0 (the default) `aero` is false and the per-particle body is
byte-identical to v1.2.0. Proven: a default seeded run's x/y/vx/vy/life/state
snapshot is Object.is-identical to v1.2.0, and the aero-off render fingerprint is
unchanged. Zero new allocation and zero new SoA column: turbulence reuses the
existing per-spawn `invLife` as its phase source, and the engine clock is a
single cold scalar.

### Added

- **S-13** air forces. Four cold config keys -- `wind` (constant px/s^2
  horizontal push), `gust` (a sin oscillation at `GUST_HZ = TAU/3` rad/s, a
  3-second period, added to wind), `turbulence` (a per-spark curl of amplitude
  `turb`, phase `invLife[i] * TURB_K + elapsed`), and `drag` (a friendlier alias
  for `friction`). A new cold scalar `_elapsed` accumulates simulated dt and
  drives the gust oscillator + turbulence phase. The hot loop gains exactly one
  hoisted `if (aero)` before the floor test; `aero = wind!==0 || gustNow!==0 ||
  turb!==0`, `gustNow` sampled once per frame in the cold preheader. Rationale in
  `decisions/0007-drag-terminal-velocity.md` and `decisions/0008-air-forces.md`.

### Changed

- **S-13** `drag` overrides `friction` when non-null AND finite (null is not
  zero), so the hot path keeps reading exactly one air-friction knob -- no new
  hot read.
- **S-13** fail-closed air knobs. A non-finite `wind`/`gust`/`turbulence` is
  coerced to `0` (off), and a non-finite `drag` is ignored, ONCE in the cold
  constructor -- a hostile config can never NaN the pool through the aero gate or
  `pow(drag, dt*60)`. Zero hot bytes (ADR 0008).
- Torture T0 gains laws 6-9 (aero-off fingerprint == v1.2.0, plus committed
  per-knob wind/gust/turbulence hashes with direction witnesses); T6 gains four
  aero lanes (wind / gust / turbulence / all-on) each pinning all 12 backing-store
  byte lengths; T9 gains two controls proving the `if (aero)` gate is load-bearing
  (aero leaked onto the aero-off path moves the fingerprint; aero lifted outside
  the moving block wakes a resting spark). New `test/aero.test.js` boundary suite.
- `VERSION`, `package.json`, `llms.txt`, and `SparkEngine.d.ts` bumped to `1.3.0`.

## [1.2.0] - 2026-08-15

Throughput (roadmap session S3, the batching wave). The hot path stops paying
per-particle for stroke state and burst stops scanning the whole pool. Particle
positions are byte-identical to v1.1.0 -- physics is untouched; only the
draw order within equal (color, width) groups changes, which is invisible.
Proven zero new allocation: the counting-sort scratch is allocated once in the
constructor and all 12 SoA/scratch `buffer.byteLength` values are pinned
byte-identical across a 20000-op T6 window.

### Added

- **S-07** batched render. A per-spawn `Uint8Array wBucket` quantizes line width
  into 4 buckets; `updateAndDraw` now counting-sorts live sparks into
  `(colorIdx * 4 + wBucket)` bins over persistent `_order`/`_binCount`/`_binStart`
  `Int32Array` scratch, then emits at most `colors.length * 4` (<= 16) stroke
  passes -- one `lineWidth`/`strokeStyle` set per pass -- instead of one full
  state change per particle. Rationale in `decisions/0006-render-batching.md`.

### Changed

- **S-08** spawn is now a ring cursor. `burst` advances `_head = (_head + 1) % max`
  and overwrites oldest under pressure, replacing the from-zero `O(max)`
  free-slot scan with `O(count)`. This makes the README's long-standing "ring
  buffer behavior" claim actually true. Every SoA lane of an overwritten slot is
  fully rewritten at spawn (no stale `life`/`invLife`/`state`); the S-05
  zero-speed and S-11 `life` guards still apply on the ring path. Rationale and
  the overwrite-oldest-vs-reuse tradeoff in `decisions/0005-spawn.md`.
- **S-09** hot-body hoisting. `gravity`, the dt-friction `f`, `stretch`, `colors`,
  `floorBase`, and all 9 SoA array refs are read into loop-preheader locals once
  per frame instead of per particle. No behavior change.
- Dropped the inaccurate `"webgl"` keyword from `package.json` -- this is a
  Canvas2D engine (S-12 metadata hygiene).

### Fixed

- **S-07 / S-08 / S-09** close the three throughput findings from the roadmap:
  stroke-state churn is now `O(buckets)` not `O(alive)`, and spawn is `O(count)`
  not `O(max)`. `destroy()` extends to null the four new scratch arrays and stays
  idempotent.

## [1.1.0] - 2026-08-15

Compositing + physics correctness (roadmap session S2). The release that unlocks
layering, makes ballistics frame-rate-independent, and lands debris where you
point it. Every change is guarded and byte-identical at the defaults: at
`dt = 1/60`, `autoClear:true`, `floorY:null`, the per-particle output is
bit-for-bit v1.0.2. Two new per-frame hoists (`f`, `floorBase`); the per-particle
body gains only the `floorY` read and loses the fused pre-move X-cull.

### Added

- **S-03** (`autoClear`, default `true`). The unconditional full-canvas
  `ctx.clearRect(0, 0, w, h)` is now guarded by `if (this.config.autoClear)`.
  Default `true` preserves the current wipe-every-frame behavior exactly; with
  `autoClear:false` the engine draws over whatever is already on the canvas, so
  pointer-following scratch sparks and fireworks/smoke layering become possible.
  Rationale in `decisions/0003-autoclear.md`.
- **S-10** (`floorY`, default `null`). Sparks can land on a HUD bar / table edge
  instead of the canvas bottom. `null` means "use `h`" (null is not zero), so the
  default is byte-identical to the hardcoded `h`. Hoisted once per frame as
  `floorBase`; the per-spark `weight/2` offset stays in the loop.

### Fixed

- **S-04** (dt-independent friction). The per-frame `v *= friction` (frame-rate
  dependent, ~28px 30-vs-120fps divergence over 1s) is replaced by a per-frame
  hoisted factor `f = Math.pow(friction, dt * 60)`, applied `v *= f`. At
  `dt = 1/60`, `dt*60 === 1` and `pow(0.99, 1) === 0.99` exactly, so the 60fps
  calibration anchor is bit-preserved; other refresh rates now converge. Floor
  `restitution`/`floorFriction` are per-bounce (event-driven) and correctly
  frame-rate independent already -- left untouched. Rationale + the 60fps
  byte-identity proof in `decisions/0004-dt-friction.md`.
- **S-05** (sleep-epsilon). A zero-speed burst (`vx === vy === 0`) no longer hangs
  in mid-air forever. At spawn (cold path), when both components are exactly `0`,
  `vy` is seeded with `1e-3` so gravity engages and the spark falls. The hot-loop
  sleep check stays two comparisons (`vx !== 0 || vy !== 0`), untouched.
- **S-06** (cull margins + post-move position). The X-cull was fused with the life
  check ABOVE the physics block, so it read the PRE-move position and clipped
  exactly at the edge -- a velocity-stretched tail popped out before it cleared.
  Now the top check is life-only (`life <= 0 -> state = 0`); the X-cull runs
  AFTER the physics block on the post-move position, widened to a 200px margin
  (`CULL_MARGIN`): a spark keeps drawing until head + tail clear the margin. No
  Y-cull (life bounds it). Sleeping sparks skip physics, so their `x` is
  unchanged and the post-move check is equivalent for them.

### Changed

- `VERSION` const and `package.json` bumped to `1.1.0`. `llms.txt` Config section
  documents `autoClear`/`floorY`, the dt-independent friction, and the
  `transparentBackground` semantic inversion vs lite-fireworks.
- Torture T0 adds law 4 (S-04 dt-scaling: one `dt` step within tolerance of two
  `dt/2` steps) and law 5 (S-03 autoClear call-count). T9 adds a control replaying
  the pre-S-04 per-frame `*= friction` model and asserting it fails the dt-scaling
  tolerance -- the gate bites. `test/boundary.test.js` flips the S-05 anchor to
  the fixed falls-to-floor behavior; `test/SparkEngine.test.js` strengthens the
  floor-bounce test to assert an actual `vy` sign flip across the bounce frame.
- README documents `autoClear`/`floorY` and the `transparentBackground` semantic
  inversion vs lite-fireworks (a cross-package trap).

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
- **S-03**/**S-04**/**S-05**/**S-06**/**S-10** (S2): fixed in 1.1.0 -- see the
  [1.1.0] entry above. autoClear guard, dt-independent friction, sleep-epsilon,
  post-move cull margin, and the `floorY` config respectively.
- **S-07** (S3, fix in S3): unbatched rendering -- per-particle
  `beginPath`/`lineWidth`/`strokeStyle`/`stroke`.
- **S-08** (S3, fix in S3): O(max) from-zero free-slot scan in `burst` every
  call, despite the README's "ring buffer" claim.
- **S-09** (S3, fix in S3): loop-invariant property loads
  (`config.gravity/friction/stretch`, `colors`, array refs) re-read per particle
  per frame.
- **S-11** (S1, fix in S1): `life=0` spawn -> `invLife = 1/0 = Infinity` ->
  `colorIdx = NaN` -> `strokeStyle = undefined`. Latent (masked by first-frame
  cull today). Repro: `burst(...,lifeMin=0,lifeMax=0)` then inspect `invLife`.

## [1.0.0]

- Initial release: zero-GC, SoA spark and debris engine with vector velocity
  stretching, floor restitution, and a precomputed OKLCH heat gradient.
