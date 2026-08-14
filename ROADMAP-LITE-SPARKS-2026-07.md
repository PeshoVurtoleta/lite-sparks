# ROADMAP-LITE-SPARKS-2026-07 — @zakkster/lite-sparks

**Current:** v1.0.0 (npm = HEAD) · 5.3 KB single-file ESM · dep: `lite-color` · devDep: vitest (to be removed)
**Verdict from audit:** small and mostly sound — the heat-gradient index via precomputed `invLife`, the floor restitution with sleep thresholds, and the velocity-stretch tails are all good ideas executed cleanly. Notably it ships the **best `.d.ts` of the quintet** (fully documented, SoA fields declared — use it as the template for smoke's F3 fix). Its problems: it unconditionally `clearRect`s the whole canvas every frame (can't composite over anything), it shares the fireworks/smoke frame-rate-dependent friction bug, the sleep-state check can freeze a zero-velocity spark in mid-air, and it renders per-particle unbatched.

Shared recipes referenced below (A–I) live in `ROADMAP-FX-REVIVAL-2026-07.md`.

---

## Audit findings ledger

**F1 — Unconditional full-canvas `clearRect` every frame (severity: high, canvas ownership).** `updateAndDraw` wipes `(0, 0, w, h)` before drawing, in **both** modes — sparks cannot be layered over a game canvas, a scratch surface, or a sibling engine, which is exactly where sparks belong. The `transparentBackground` flag only switches compositing (`false` → `'lighter'`, `true` → `'source-over'`) and its meaning is inverted relative to fireworks' flag of the same name — a cross-package trap. Fix: `autoClear: true` config (default preserves behavior); with `autoClear: false` the engine draws over whatever is there, making pointer-following scratch sparks and fireworks/smoke layering possible. Document the `transparentBackground` semantic difference vs fireworks in both READMEs (renaming would break API — note as a candidate for a future 2.0 alignment, not this arc).

**F2 — Frame-rate-dependent friction.** `vx *= friction; vy *= friction` per frame, same defect as fireworks F1 / smoke F4, and with `friction: 0.99` the drift is subtle enough to go unnoticed while still changing spark ballistics across refresh rates. Same fix: per-frame hoisted `f = Math.pow(cfg.friction, dt * 60)`, 60 fps behavior bit-preserved. Floor `restitution` and `floorFriction` are per-bounce (event-driven) and correctly frame-rate independent — leave them.

**F3 — Sleep-state check freezes zero-velocity sparks in mid-air.** Physics is bypassed when `vx === 0 && vy === 0` — the sleep optimization for floor-resting sparks. But a spark spawned with `speedMin = speedMax = 0` (or damped to exact zero mid-flight before any bounce) satisfies the check while airborne: gravity never applies and it hangs until `life` expires. Fix in the cold path, not the hot body: at `burst`, if computed speed is 0, seed `vy` with a tiny epsilon (e.g. `1e-3`) so gravity engages; the hot-loop check stays two comparisons. Ledger the alternative (adding a floor-proximity term to the sleep check) as rejected — it adds bytes to the hot body for an edge reachable only at spawn.

**F4 — Cull margins are zero and X-only.** Sparks die at `x < 0 || x > w` exactly — a spark whose head crosses the edge vanishes while its stretched tail was still visible (pop at screen edges). No upward-Y cull exists, but unlike rain there is **no leak class**: `life` always decrements, so every spark is bounded. Fix: widen X cull to the shared 200 px margin (Recipe G) — cheap, kills the edge pop, and leaves room for the v1.3.0 wall-bounce option to reuse the same bounds.

**F5 — Unbatched rendering.** Per-particle `beginPath` / `lineWidth` / `strokeStyle` / `stroke` — same class as fireworks F4. Batching axes: `colorIdx` has only 4 heat levels (or palette length), but `lineWidth` = per-particle `weight` (continuous 1.0–4.0) and width is path-level state. Plan: quantize weight into 4 buckets at spawn (`Uint8 wBucket`, cold path) → ≤ 16 passes (4 colors × 4 widths) over persistent index lists, vs thousands of stroke calls. Bench-driven like fireworks' comet-mode decision; ledger if the width quantization reads as visible banding at typical spark sizes (expected: it won't — sub-pixel-ish widths at 1–4 px).

**F6 — O(max) free-slot scan in `burst`.** Recipe D ring cursor; burst spawns dozens of sparks per impact, so this compounds fast during sustained grinding/welding emission.

**F7 — Loop-invariant property loads.** `config.gravity`, `config.friction` (→ `f`), `config.stretch`, `colors`, array refs — Recipe E hoisting.

**F8 — Floor is hardcoded to `h`.** Parity gap with snow/rain v1.1.0: add `floorY` config (default `h`) so sparks land on a HUD bar / table edge rather than the viewport bottom. The per-spark `weight/2` offset stays.

**F9 — Metadata.** `"webgl"` keyword inaccurate; no CHANGELOG; `lite-color` `^1.0.5` → `^1.1.0`; vitest devDep. (Recipe I.)

**F10 — Test gaps.** No `--expose-gc` proof, no soak, no seeded determinism snapshot, no dt/dimension abuse; the floor-bounce test asserts only `y ≤ h` (weak — should assert an actual sign flip on `vy` across the bounce frame). (Recipes B, C.)

---

## v1.1.0 — Compositing + physics correctness + node:test *(target: session S4)*

- F1: `autoClear` config (release headline — unlocks every integration this package exists for).
- F2: dt-independent friction, reusing the calibration + cross-rate equivalence test pattern landed in fireworks S3 the session before.
- F3: zero-speed epsilon seed at `burst`.
- F4: 200 px X-cull margins.
- F8: `floorY` config.
- Migrate `SparkEngine.test.js` to `node:test` per Recipe A; delete `vitest.config.js`; devDependencies to zero. Strengthen the bounce test (vy sign flip) while touching it.
- F9 hygiene: keywords, CHANGELOG.md, `lite-color` `^1.1.0`; README note on `transparentBackground` semantics vs fireworks.
- Gate: suite green on M4 + Intel.

## v1.2.0 — Batching wave *(session S7, shared W2)*

- F5: heat×weight bucketed rendering (≤ 16 passes) over persistent index lists; decision benched and ledgered alongside fireworks' comet-mode call — same machinery, do them together.
- F6: ring cursor. F7: hot-body hoisting.
- Recipe B zero-GC suite (flight + floor-rest branches), Recipe C torture suite (dt abuse, `max=0/1`, burst-into-full-pool, sustained-emission soak, seeded determinism snapshot over `x/y/vx/vy/state`).
- Recipe F bench: burst throughput, physics-only, full frame at 1/8/32 bursts + sustained 500-spark emission; VersionMatrix vs v1.1.0; ≤ 3 % Intel gate.
- SPP probes: `sparks.burst`, `sparks.physics`, `sparks.render`.

## v1.3.0 — Features *(session S9)*

- **`SPARK_PRESETS`.** `weld` (tight cone, white-hot palette, short life), `grind` (directional fan, sustained), `impact` (radial, heavy weights, strong restitution), `ember` (slow, long life, low restitution, cherry-heavy palette).
- **Wall bounce (optional).** `wallRestitution: 0` (default off = current cull behavior): non-zero reflects `vx` at the F4 bounds instead of culling — contained sparks for boxed UI panels. One branch replacing the cull branch, only when enabled.
- **Sustained emitters.** Reuse smoke's v1.3.0 `makeEmitter` descriptor + fractional-rate accumulator pattern (copied, not shared code) for continuous welding/grinding sources — one call per frame, zero per-call allocation.
- **`onBounce(x, vx, weight)` hook.** Primitives-only callback fired on floor contact above a velocity threshold — the `lite-audio` wiring point for metallic tick/scatter sounds, mirroring fireworks' `onLaunch`/`onBurst` hooks from its v1.3.0.

## v1.4.0 — Integration + docs *(session S10)*

- **Scratch-card pointer sparks (flagship dogfood).** The single best fit in the quintet for lite-scratch-fx / Vikings: `autoClear: false` sparks layered over the scratch canvas, `grind` preset bursts following `pointermove` along the scratch path. Ship as a documented recipe and feed the Vikings rewrite findings back here.
- Fireworks pairing recipe: sparks as burst debris under a fireworks layer (both compositing-safe modes, z-order and blend notes).
- Oscilloscope-blueprint demo: preset gallery, wall-bounce boxed scene, sustained-emitter scene, pointer-follow scene, stress scene with SPP readouts.
- Worker + OffscreenCanvas README recipe (Recipe H).
- README refresh: Mermaid diagram (burst → flight → bounce/rest → idle), llms.txt regeneration, bench provenance table.

## Non-goals

Spark-vs-spark or arbitrary-geometry collision (floor + optional walls only), glow/bloom post-processing (the `'lighter'` compositing is the whole trick), heat palettes beyond the indexed-gradient model (palette length is already configurable), renaming `transparentBackground` (2.0-only breaking change, parked).
