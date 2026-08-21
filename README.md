# @zakkster/lite-sparks

> Zero-GC SoA spark and debris engine. Vector velocity stretching, floor-bounce restitution, air forces, containment walls, a vortex field, floor-contact hooks, and a precomputed thermodynamic OKLCH heat gradient -- every particle a line, every hot frame allocating nothing. One dependency.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-sparks.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-sparks)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-sparks?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-sparks)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-sparks?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-sparks)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-sparks?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-sparks)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)

## The spark engine the ecosystem was missing

`lite-sparks` is the ballistic-debris end of the `@zakkster` motion stack. `lite-fireworks` launches shells and blooms color into the sky. `lite-scratch-fx` reveals a surface under a pointer. Neither one does the low, heavy, gravity-bound thing a welder, an angle grinder, or a sword clash throws off: **short-lived streaks of hot metal that stretch along their velocity, arc under real gravity, bounce off a floor with restitution, and cool from white-hot to cherry-red as they die** -- thousands of them, at 60fps, allocating nothing per frame. Sparks is that piece.

It is a pure engine. It owns no canvas, no RAF loop, no DOM. You hand it a 2D context, a `dt`, and a size; it advances the physics and issues the strokes. That is the whole contract, which is exactly why it drops into a game canvas, a worker + `OffscreenCanvas`, or a second layer over any other renderer.

```bash
npm install @zakkster/lite-sparks
```

Peer dependency (bundled as a normal dependency, OKLCH -> CSS string conversion):

```bash
npm install @zakkster/lite-color
```

```javascript
import { SparkEngine } from '@zakkster/lite-sparks';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const sparks = new SparkEngine(5000);          // pre-allocated pool of 5000

let last = performance.now();
function loop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);   // seconds, clamped
    last = time;
    sparks.updateAndDraw(ctx, dt, canvas.width, canvas.height);
    requestAnimationFrame(loop);
}

// Impact burst on click: 60 sparks, full radial, 150-800 px/s, 0.2-0.7s life.
canvas.addEventListener('pointerdown', (e) => {
    sparks.burst(e.clientX, e.clientY, 60, 0, Math.PI * 2, 150, 800, 0.2, 0.7);
});

requestAnimationFrame(loop);
```

One factory, one burst call, one per-frame call. Everything else is config -- all of it live-mutable between frames, all of it off by default so the hot loop stays byte-for-byte the ballistic core until you ask for more.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The core surface](#the-core-surface)
- [API reference](#api-reference)
  - [SparkEngine](#sparkengine)
  - [Config reference](#config-reference)
  - [Presets and emitters](#presets-and-emitters)
  - [Contract constants](#contract-constants)
- [Composability with the ecosystem](#composability-with-the-ecosystem)
  - [Layering over lite-fireworks](#layering-over-lite-fireworks)
  - [A spark layer over lite-scratch-fx](#a-spark-layer-over-lite-scratch-fx)
  - [Worker + OffscreenCanvas](#worker--offscreencanvas)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Benchmarks](#benchmarks)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Spark and debris VFX have three problems that no small library solves at once:

1. **The GC pause lands as visible jitter.** A spark shower is thousands of short-lived particles: born in a burst, dead in under a second, replaced by the next burst. The naive object-per-particle design allocates and discards that whole population every second -- and V8's major collections land as frame drops right when the effect is busiest. lite-sparks stores the entire pool in flat `Float32Array` / `Uint8Array` columns (structure-of-arrays), spawns by advancing a ring cursor over dead slots, and issues draws by counting-sort into color/width bins. The steady-state hot path allocates **zero bytes** -- proven under `--expose-gc` with **0 major GCs**.

2. **Sparks are not bloom dots.** A real spark is a *streak*: a line drawn from the particle's position back along its velocity vector. Fast sparks are long comets; slow ones are near-dots. Most particle libraries draw a textured quad or a circle and call it a spark. lite-sparks draws the line, stretches it by velocity, quantizes its width into buckets so a whole bin strokes in one path, and colors it by a thermodynamic heat gradient so it *cools* as it dies.

3. **Debris obeys physics you can feel.** Gravity that is heavier than fireworks. A floor it bounces off with restitution and skids along with friction, then falls asleep when it settles so it costs no CPU. Optional wind, gusts, and per-spark turbulence; optional containment walls and a vortex attractor; an optional floor-contact hook so a bounce can trigger a sound or a secondary effect. Every one of those is a cold-path config knob that fails closed on a hostile value and stays byte-identical-dead when it is off.

Existing options: a general particle engine (heavyweight, object-per-particle, no streak model), a hand-rolled canvas loop (re-derives the physics and the batching every project, and the GC bites), or a full game engine (not embeddable in a plain page). lite-sparks is the single-file engine for this specific job.

---

## What you get

- **`SparkEngine`** -- the stateful engine. One pre-allocated SoA pool; `burst()` to spawn, `updateAndDraw()` once per frame, `clear()` / `destroy()` to tear down. Everything below rides on it.
  - **Ballistic core** -- gravity, dt-independent air friction, velocity-stretched line rendering, a heat-gradient color derived from remaining life, floor-bounce restitution with a sleep state for settled debris.
  - **Air forces** -- `wind` (a constant horizontal push), `gust` (a sin oscillation), `turbulence` (a per-spark curl seeded by each spark's inverse life so neighbors wander apart). One hoisted `if (aero)` gate; every knob 0 -> the gate is off.
  - **Containment + vortex** -- `wallLeft` / `wallRight` / `ceiling` position clamps with velocity reflection, and an `attract` / `swirl` vortex field toward `(attractX, attractY)`, each axis clamped so a hostile scalar can never teleport a spark.
  - **Debris vocabulary** -- an `onBounce(x, vx, weight)` floor-contact hook (primitives only, gated on impact strength), and a `scaleTo` / `fadeOut` per-particle enveloped render lane (life-driven width scale + alpha fade).
- **`SPARK_PRESETS`** -- four frozen burst descriptors (`weld`, `grind`, `impact`, `ember`) tuned to real debris signatures.
- **`burstPreset(engine, x, y, preset)`** -- a zero-alloc positional adapter that fires a preset with no spread and no temp object.
- **`makeEmitter({ x, y, rate, cone, speed, life })`** -- a fractional-carry emitter whose `.step(engine, dt)` averages exactly `rate` sparks/sec over time, spawning the integer part and carrying the remainder -- a zero-alloc step.
- **`VERSION`** -- the package version string constant.

Full types ship in [`SparkEngine.d.ts`](./SparkEngine.d.ts). Every export and every config key is documented.

---

## The core surface

<details>
<summary>How a spark is stored, moved, and drawn -- and why each choice is zero-GC.</summary>

**Storage is structure-of-arrays.** There is no `Spark` object. The pool of `max` particles lives in parallel typed-array columns: `x`, `y`, `vx`, `vy`, `life`, `invLife`, `weight` as `Float32Array`, `state` as `Uint8Array`, plus a `wBucket` `Uint8Array` (quantized line width) and three `Int32Array` counting-sort scratch buffers. Every one is allocated once in the constructor. A "spark" is just an index `i` shared across all columns.

**Spawn is a ring cursor (overwrite-oldest).** `burst()` advances a single `_head` cursor `head = (head + 1) % max` and claims each slot it lands on -- alive or dead. There is no free-slot scan, so a burst is O(count), not O(count * max). Under pressure a burst evicts the oldest live sparks, which is exactly the right visual: the newest debris wins the pool. A `count` below 1 (or `NaN` / `Infinity`) spawns nothing; a `count` past `max` is capped to `max` (a burst can only ever fill the pool).

**`invLife` is precomputed to kill a per-frame divide.** The heat color comes from the remaining-life ratio `life * invLife` (0..1), where `invLife = 1 / life` is computed once at spawn. The render loop multiplies instead of dividing, and the color index is a floored multiply with a branchless clamp into `heatColors`.

**Physics has a sleep gate.** A moving spark integrates gravity, friction (`pow(friction, dt*60)`, so drag is frame-rate independent), the air forces, and the vortex. When it hits the floor it bounces (`vy *= -restitution`, `vx *= floorFriction`); once its bounce speed drops below the rest threshold it is pinned to `vy = 0`, and once it stops sliding it is fully asleep (`vx = vy = 0`). A sleeping spark skips the entire physics body -- settled debris costs almost nothing.

**Rendering is counting-sort batched.** Each live spark is binned by `colorIdx * 4 + wBucket`. A three-phase pass (count, prefix-sum, scatter) orders every spark by bin, then issues **one** `strokeStyle` / `lineWidth` set and **one** batched path per non-empty bin -- at most `heatColors.length * 4` state changes per frame instead of one per particle. Each spark contributes two path ops (`moveTo` head, `lineTo` the velocity-stretched tail). The `enveloped` lane (scale/fade on) trades the batch for one stroke per spark so each can carry its own width and alpha.

</details>

---

## API reference

### SparkEngine

```ts
new SparkEngine(maxParticles?: number, config?: SparkConfig)
```

- **`maxParticles`** -- pool capacity. Default `5000`. Fixed-size; the pool never grows.
- **`config`** -- any of the keys in [Config reference](#config-reference). Live-mutable on `engine.config` after construction. A non-finite value on any guarded knob fails closed in the constructor (see the table), so the hot loop never sees `NaN`.

```ts
engine.burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin?, lifeMax?): void
engine.updateAndDraw(ctx, dt, w, h): void
engine.clear(): void
engine.destroy(): void
```

- **`burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin = 0.5, lifeMax = 1.5)`** -- spawn `count` sparks at `(x, y)` inside an angular cone. Angles are in radians (canvas convention: `-TAU/4` is straight up, `0` is right, `TAU/2` is left, `TAU/4` is down). Each spark gets a uniform-random angle in `[angleMin, angleMax)`, speed in `[speedMin, speedMax)`, and life in `[lifeMin, lifeMax)`. All six cone/speed/life args are coerced independently with `Number.isFinite` at entry (a hostile arg fails closed; a valid burst skips the coercion, so a seeded RNG sequence is untouched). A `count < 1` / `NaN` / `Infinity` spawns nothing.
- **`updateAndDraw(ctx, dt, w, h)`** -- advance physics and render every live spark. Call once per frame. `dt` is in seconds; a non-positive or non-finite `dt` is a silent no-op frame (fail closed), and `dt > 0.1` is clamped (tab-backgrounding guard). `w` is the stage width (drives the horizontal cull); `h` is the default floor Y when `floorY` is `null`.
- **`clear()`** -- kill every particle immediately (state and life zeroed). The pool is reused.
- **`destroy()`** -- null all nine SoA/color arrays plus the four batching scratch buffers. Idempotent; every method is a no-op after `destroy()`.

The engine exposes its columns as public fields (`x`, `y`, `vx`, `vy`, `life`, `invLife`, `weight`, `state`, `wBucket`) for read-only inspection and the torture harness; they become `null` after `destroy()`.

### Config reference

All keys are optional and live-mutable on `engine.config`. Guarded knobs are sanitized ONCE in the constructor, never in the hot loop.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gravity` | number | `800` | Downward acceleration in px/s^2. Debris is heavy -- higher than fireworks. |
| `friction` | number | `0.99` | Air-drag retention per 1/60s, applied as `pow(friction, dt*60)` so it is frame-rate independent. |
| `floorFriction` | number | `0.85` | Horizontal velocity retained on a floor bounce. Lower = sparks skid less. |
| `restitution` | number | `0.4` | Vertical bounce energy retained (`0` = dead stop, `1` = perfectly elastic). |
| `stretch` | number | `0.04` | Velocity-to-tail multiplier: the tail is `(x - vx*stretch, y - vy*stretch)`. Higher = longer comets. |
| `drag` | number \| null | `null` | Friendlier alias for `friction`: when non-null AND finite it OVERRIDES `friction` (null is not zero). |
| `wind` | number | `0` | Constant horizontal push in px/s^2 (+ is rightward). `0` disables the wind term. |
| `gust` | number | `0` | Gust amplitude in px/s^2: a `sin` oscillation at `TAU/3` rad/s (3s period) added to wind. `0` disables it. |
| `turbulence` | number | `0` | Per-spark curl amplitude in px/s^2, phase seeded by each spark's `invLife` so neighbors diverge. `0` disables it. |
| `wallLeft` | number \| null | `null` | Left wall X: a moving spark is clamped to `x >= wallLeft` and its inward `vx` reflected. `null` = no wall (null is not zero -- a wall AT 0 is a real edge). |
| `wallRight` | number \| null | `null` | Right wall X: clamp to `x <= wallRight`, reflect inward `vx`. `null` = no wall. |
| `ceiling` | number \| null | `null` | Ceiling Y: clamp to `y >= ceiling`, reflect inward `vy`. `null` = no ceiling. |
| `attract` | number | `0` | Vortex radial pull toward `(attractX, attractY)` in px/s^2; negative repels. Clamped per axis to +/-`VORTEX_MAX_ACCEL`. `0` disables it. |
| `swirl` | number | `0` | Vortex tangential push perpendicular to the radius in px/s^2. Clamped per axis to +/-`VORTEX_MAX_ACCEL`. `0` disables it. |
| `attractX` | number | `0` | Vortex center X. Read only when `attract`/`swirl` is non-zero. |
| `attractY` | number | `0` | Vortex center Y. Read only when `attract`/`swirl` is non-zero. |
| `onBounce` | function \| null | `null` | Floor-contact hook `(x, vx, weight)`, primitives only, called on a bounce when the PRE-bounce downward speed exceeds `onBounceMinSpeed`. A non-function coerces to `null`. No try/catch -- a throw surfaces. Must not mutate the engine mid-frame. |
| `onBounceMinSpeed` | number | `0` | Minimum pre-bounce downward speed (px/s) for `onBounce` to fire; a gentle settle below it is silent. Non-finite -> 0. |
| `scaleTo` | number | `1` | Per-particle line-width multiplier reached at end of life (`1` = no scale). Non-`1` enables the enveloped render lane. Non-finite -> 1. |
| `fadeOut` | number | `0` | Per-particle alpha reduction reached at end of life (`0` = opaque, `1` = fully faded). Non-`0` enables the enveloped lane. Non-finite -> 0. |
| `transparentBackground` | boolean | `false` | Selects the blend mode: `false` -> `'lighter'` (additive, dark bg), `true` -> `'source-over'` (light bg). NOT a clear policy -- see the [layering trap](#layering-over-lite-fireworks). |
| `autoClear` | boolean | `true` | `true` wipes the canvas each frame; `false` draws over existing pixels so sparks layer over another surface (you own the clear). |
| `floorY` | number \| null | `null` | Landing-floor Y. `null` -> use the `h` passed to `updateAndDraw` (null is not zero). Set a pixel value to land sparks on a HUD bar / table edge. |
| `heatColors` | Array | 4 OKLCH stops | Heat gradient of `{ l, c, h }` OKLCH objects or CSS strings. Index 0 = coldest (dying), last = hottest (born). Pre-parsed to CSS in the constructor. |
| `rng` | function | `Math.random` | RNG `() => number` in `[0, 1)`. Inject a seeded RNG for deterministic replays. |

The default gradient is a 4-stop thermodynamic ramp: cherry red `{l:0.30, c:0.20, h:20}` -> orange `{l:0.60, c:0.25, h:30}` -> yellow `{l:0.85, c:0.20, h:70}` -> white-hot core `{l:0.98, c:0.05, h:90}`. A spark walks it backward -- born hot, cooling to red as its life runs out.

### Presets and emitters

```ts
SPARK_PRESETS: Readonly<{ weld, grind, impact, ember }>
```

Four frozen descriptors, each holding the seven positional `burst` fields. `ember` additionally carries `scaleTo` / `fadeOut` -- these are *engine-config hints* (pass them to `new SparkEngine(max, { scaleTo, fadeOut })`), not burst args, and `burstPreset` ignores them.

| Preset | Signature | Feel |
| --- | --- | --- |
| `weld` | 40 sparks, tight near-vertical cone, 300-900 px/s, 0.3-0.9s | A welding torch: fast, white-hot, short-lived. |
| `grind` | 30 sparks, wide upward fan, 200-700 px/s, 0.4-1.1s | An angle grinder: a broad medium-speed spray. |
| `impact` | 60 sparks, full 360-degree radial, 150-800 px/s, 0.2-0.7s | A sword clash / hammer strike. |
| `ember` | 20 sparks, gentle upward drift, 40-160 px/s, 1.2-2.4s | Slow floating cinders (`scaleTo: 0.2`, `fadeOut: 0.9`). |

```ts
burstPreset(engine, x, y, preset): void
```

Fires a preset at `(x, y)` by reading its fields and calling `engine.burst` positionally -- no spread, no temp array, no temp object, so it allocates nothing. A `null` / `undefined` preset is a no-op (fail closed).

```ts
makeEmitter({ x?, y?, rate?, cone?, speed?, life? }): Emitter
emitter.step(engine, dt): void
```

Builds a fractional-rate emitter. `step` adds `rate * dt` sparks-worth of credit to a `carry` accumulator, spawns the integer part (an upward cone of half-width `cone`, speed `[speed*0.5, speed]`, life `[life*0.5, life]`), and keeps the remainder -- so a sub-frame rate (e.g. 2.5/frame) averages exactly `rate` over time instead of truncating the fraction away each frame. Zero allocation per step. Fail-closed construction: a non-finite/negative `rate`/`speed`/`life` -> 0 (an inert emitter), a non-finite `x`/`y`/`cone` -> 0.

### Contract constants

Read the real values from `SparkEngine.js`; these drive the fail-closed guards and the batching.

| Constant | Value | Meaning |
| --- | --- | --- |
| `VERSION` | `'1.5.0'` | Package version string (exported). |
| default `maxParticles` | `5000` | Pool capacity when the constructor arg is omitted. |
| `VORTEX_MAX_ACCEL` | `4000` px/s^2 | Per-axis clamp on the combined attract+swirl vortex accel (5x default gravity). Bounds a hostile scalar. |
| `CULL_MARGIN` | `200` px | Post-move X-cull margin so a velocity-stretched tail finishes drawing before head+tail clear the edge. |
| dt clamp | `0.1` s | `dt` above this is clamped (tab-backgrounding teleport guard). |
| life clamp | `1e-4` s | Spawn life is clamped away from 0 so `invLife` is never `Infinity` and the color index is never `NaN`. |
| rest threshold | `20` px/s | Below this post-bounce vertical speed a spark pins to `vy = 0`; below `5` px/s horizontal it fully sleeps. |
| `wBucket` range | `0..3` | Line width quantized into 4 buckets at spawn; the batched lane strokes each at width `1..4` px. |
| bin count | `heatColors.length * 4` | Counting-sort bins = colors x width buckets; the per-frame stroke-state ceiling. |
| gust frequency | `TAU/3` rad/s | The gust oscillator's angular frequency (a 3-second period). |
| turbulence phase scale | `1000` | Scales each spark's `invLife` into its turbulence phase so near-equal-life sparks diverge. |

---

## Composability with the ecosystem

lite-sparks owns no canvas, so it layers cleanly. Three real pairings follow.

### Layering over lite-fireworks

Run a fireworks show and throw sparks off the burst points as a second layer. Two things matter: **z-order** and a **cross-package naming trap**.

Z-order: draw fireworks first, sparks on top. Either give sparks their own transparent canvas stacked above the fireworks canvas, or draw both into one canvas with `autoClear: false` on the sparks so they do not wipe the fireworks frame.

> **Trap -- `transparentBackground` is INVERTED between the two packages.**
> In **lite-sparks**, `transparentBackground` picks the *blend mode*: `false` (the default) -> `'lighter'` additive for dark backgrounds, `true` -> `'source-over'` for light backgrounds. In **lite-fireworks**, the same-named flag means the opposite kind of thing -- whether the background is *wiped see-through* (`true` -> `clearRect`) or painted with a fade trail (`false` -> `fillRect(fadeColor)`). They do NOT match. To layer sparks over an existing frame in lite-sparks, reach for `autoClear: false`, never `transparentBackground`.

```javascript
import { FireworksEngine } from '@zakkster/lite-fireworks';
import { SparkEngine, burstPreset, SPARK_PRESETS } from '@zakkster/lite-sparks';

const ctx = canvas.getContext('2d');
const fw = new FireworksEngine(2000);
const sparks = new SparkEngine(4000, {
    autoClear: false,             // fireworks owns the frame clear; sparks draw on top
    gravity: 1000,                // heavier than the shells, so debris rains down
});

function loop(time) {
    const dt = /* seconds, clamped */;
    fw.updateAndDraw(ctx, dt, w, h);        // layer 1: shells + blooms, clears the frame
    sparks.updateAndDraw(ctx, dt, w, h);    // layer 2: debris, over the fireworks
    requestAnimationFrame(loop);
}

// Throw an impact shower wherever a shell detonates.
function onDetonation(x, y) {
    burstPreset(sparks, x, y, SPARK_PRESETS.impact);
}
```

### A spark layer over lite-scratch-fx

`@zakkster/lite-scratch-fx` ships its OWN particle engine and its OWN `requestAnimationFrame` ticker (via `@zakkster/lite-soa-particle-engine`) -- you do not inject sparks *into* it. The honest recipe is a **second, layered spark canvas driven by the same `pointermove` path**: the scratch controller reveals the surface, and lite-sparks throws grinding sparks off the same coordinates on a canvas stacked above it.

```javascript
import { createScratchController } from '@zakkster/lite-scratch-fx';
import { SparkEngine, makeEmitter } from '@zakkster/lite-sparks';

// scratch-fx owns the reveal on its own canvases + its own ticker.
const scratch = createScratchController(sourceCanvas, effectCanvas, { /* ... */ });

// A separate, transparent overlay canvas for sparks, above the scratch layer.
const sparkCtx = sparkOverlay.getContext('2d');
const sparks = new SparkEngine(3000, { gravity: 900 });
const grinder = makeEmitter({ rate: 600, cone: 1.1, speed: 700, life: 1.0 });

// Same pointer path feeds both: scratch-fx reveals, sparks grind off the point.
sparkOverlay.addEventListener('pointermove', (e) => {
    grinder.x = e.offsetX;
    grinder.y = e.offsetY;
});

// lite-sparks owns its own light RAF for the overlay (scratch-fx owns its own).
let last = performance.now();
function sparkLoop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);
    last = time;
    grinder.step(sparks, dt);
    sparks.updateAndDraw(sparkCtx, dt, sparkOverlay.width, sparkOverlay.height);
    requestAnimationFrame(sparkLoop);
}
requestAnimationFrame(sparkLoop);
```

### Worker + OffscreenCanvas

The engine takes a `ctx` and owns no DOM, no `window`, no globals -- so it is legal inside a Web Worker driving an `OffscreenCanvas`. Transfer the canvas control to the worker, import the engine there, and drive it off the worker's own loop. `VERSION` is available for a handshake.

```javascript
// main thread
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);

// worker.js
import { SparkEngine, VERSION } from '@zakkster/lite-sparks';

let ctx, sparks;
self.onmessage = (e) => {
    if (e.data.canvas) {
        ctx = e.data.canvas.getContext('2d');
        sparks = new SparkEngine(5000);
        const w = e.data.canvas.width, h = e.data.canvas.height;
        let last = performance.now();
        const loop = (t) => {
            const dt = Math.min((t - last) / 1000, 0.1); last = t;
            sparks.updateAndDraw(ctx, dt, w, h);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
};
console.log('sparks worker', VERSION);
```

---

## Zero-GC design notes

<details>
<summary>What the hot path allocates (nothing), and how it stays that way.</summary>

The constructor allocates the entire pool -- ten typed-array columns plus three counting-sort scratch buffers -- and pre-parses the heat gradient to CSS strings. After that, the hot path never allocates:

| Operation | Steady-state allocations |
| --- | --- |
| `burst()` (spawn loop) | **0** -- writes into pre-allocated columns via the ring cursor |
| `updateAndDraw()` physics + cull | **0** -- integer/float math on typed arrays |
| `updateAndDraw()` counting-sort | **0** -- scratch buffers cleared in place, never grown |
| `updateAndDraw()` batched render | **0** -- one path per non-empty bin, no temp geometry |
| `burstPreset()` | **0** -- positional call, no spread, no temp object |
| `emitter.step()` | **0** -- carry accumulator, positional `burst` |

`burst`'s finiteness door and every config guard are cold: they run in the constructor (or once at `burst` entry, skipped entirely for a valid burst), never in the per-particle body. The air/wall/vortex/envelope features are each a single hoisted `if` gate read from a preheader local; when a feature is off its whole block is byte-identical-dead, so the aero-off/containment-off hot body is unchanged from the ballistic core. The torture harness (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`) proves **0 retained bytes** across churn and **0 major GCs** across a 200000-frame hot loop under `--expose-gc`, alongside the committed determinism fingerprints.

</details>

---

## Benchmarks

Engine-CPU timings for the three hot lanes. The context is a no-op stub (every method `() => {}`), so these measure the engine -- physics, counting-sort, path issuing -- and **NOT** canvas rasterization; a real 2D context's `stroke()` / `clearRect` cost is not included. Every buffer is pre-allocated outside the timed loop. Methodology: 2000 discarded warmups, then 20000 reps, reporting the **median** (and the min).

| Lane | What it measures | Median | Min |
| --- | --- | --- | --- |
| Burst throughput | one 300-spark radial `burst()` | `0.0118` ms/burst (`25.4` M sparks/sec) | `0.0100` ms |
| Full-frame @ 5000 alive | one `updateAndDraw` on a saturated pool | `0.058` ms/frame | `0.047` ms |
| Sustained emission | `emitter.step` + full `updateAndDraw`, ~650 alive | `0.0158` ms/frame | `0.0134` ms |

A full 5000-spark pool advances and issues its draws in **~0.058 ms of engine time** -- under 0.4% of a 16.6 ms / 60 fps frame budget, leaving the rest for your actual canvas rasterization and game logic.

```bash
node --expose-gc bench/bench.mjs   # prints the table above + a provenance line
```

Provenance (a given row is comparable only against the same runtime): **node v26.3.1, darwin/arm64, Apple M4 Pro, 2026-08-21, pool = 5000, dt = 1/60, stub-ctx (engine-only)**. The bench script is not shipped (not in `package.json` `files[]`); clone the repo to reproduce on your own hardware.

---

## Design decisions worth knowing

- **A spark is a line, not a dot.** Every particle renders as a stroke from its head `(x, y)` to a velocity-stretched tail `(x - vx*stretch, y - vy*stretch)`. This is the whole visual identity: fast sparks are long comets, slow ones are near-dots, and the streak reads as motion without any per-frame trail buffer.
- **Overwrite-oldest, not grow.** The pool is fixed at `maxParticles`. A burst that would overflow evicts the oldest live sparks via the ring cursor rather than allocating -- O(count) per burst, and the newest debris always wins the pool. Size the pool for your peak; it never reallocates. (Rationale in `decisions/0005-spawn.md`.)
- **Friction is frame-rate independent.** `friction` is applied as `pow(friction, dt*60)`, so drag is identical at 60fps, 120fps, or a stuttering frame -- at `dt = 1/60` the output is byte-identical to a naive per-frame multiply.
- **Off is byte-identical-dead.** Air forces, walls, the vortex, `onBounce`, and the scale/fade envelope are each one hoisted `if` gate. With every knob at its default (0 / null / off), each block compiles out of the hot path entirely -- the ballistic core is exactly the code that runs. This is why every feature added across v1.2 -> v1.4 left the aero-off determinism fingerprints bit-identical.
- **Fail closed on every unverified state.** Non-finite config knobs are sanitized ONCE in the constructor (`NaN` wind/gust/turbulence -> 0, a non-finite wall -> `null`, a hostile `attract`/`swirl` -> 0, a `NaN` `scaleTo` -> 1). `burst`'s six cone/speed/life args are coerced independently at entry. `null` is never coerced to zero -- a wall AT 0 is a real edge, and a `null` wall is no wall. A hostile value can never NaN-poison the whole pool through a config or `burst` door.
- **Batched by color and width.** The render counting-sorts sparks into `heatColors.length * 4` bins and issues one path per bin, capping stroke-state changes per frame regardless of particle count. The `enveloped` lane opts out (one stroke per spark) only when `scaleTo`/`fadeOut` demand per-particle width and alpha. (Rationale in `decisions/0006-batching.md`.)

---

## Testing

**150 node:test cases** across six suites, plus a torture gate of determinism fingerprints, back every claim above.

```bash
npm test          # 150 node:test cases (contract + boundary + aero + containment + vocabulary)
npm run torture   # @zakkster/lite-leak + lite-gc-profiler: 0 retained + 0 major GC + 16 frozen hashes
npm run verify    # test + torture, the publish gate
```

The suites cover the ballistic core, the batched render, the fail-closed doors (a hostile `dt` / `count` / cone arg is a no-op, never a poisoned pool), the air forces, containment walls, the vortex clamp, and the debris vocabulary (presets, the emitter's fractional carry, the `onBounce` gating, the enveloped lane). The torture harness (`node --expose-gc test/torture.mjs`) commits **sixteen determinism fingerprints** -- the aero-off hash plus wind/gust/turb, wall/ceil, vortex/swirl, weld/grind/impact/ember, emitter, scale/fade, and a hostile-burst hash -- so any accidental change to the hot loop's numeric output fails loud. No gate output is a FAIL.

---

## What this is not

- **Not a fireworks engine.** No shells, no aerial ascent, no color-shell blooms. That is `@zakkster/lite-fireworks`; lite-sparks is the low, heavy debris it can throw off (see [Composability](#layering-over-lite-fireworks)).
- **Not a general particle system.** No sprites, no textures, no per-particle images, no 3D. Every particle is a velocity-stretched line colored by a heat gradient. If you need textured quads, reach for a full particle engine.
- **Not a canvas manager.** It owns no canvas, no RAF loop, no resize handling, no DOM. You pass it a `ctx`, a `dt`, and a size. That is deliberate -- it is what lets it run in a worker, a second layer, or an `OffscreenCanvas`.
- **Not a physics solver.** No inter-particle collision, no constraints, no soft bodies. Gravity, drag, a floor, optional air/walls/vortex -- the forces a spark shower needs, nothing more.
- **Not a WebGL renderer.** It issues 2D-context strokes. For millions of GPU particles, this is the wrong tool; for thousands of CPU-cheap debris streaks over any 2D canvas, it is the right one.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-fireworks`](https://www.npmjs.com/package/@zakkster/lite-fireworks) -- shell launch + color-bloom fireworks engine (the natural layer under sparks)
- [`lite-scratch-fx`](https://www.npmjs.com/package/@zakkster/lite-scratch-fx) -- pointer-driven scratch-to-reveal with its own particle ticker
- [`lite-color`](https://www.npmjs.com/package/@zakkster/lite-color) -- OKLCH -> CSS string conversion (sparks' one dependency)
- [`lite-random`](https://www.npmjs.com/package/@zakkster/lite-random) -- seeded RNG for deterministic spark replays (inject via `config.rng`)
- **`lite-sparks`** -- this package

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
