# @zakkster/lite-sparks

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-sparks.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-sparks)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-sparks?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-sparks)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-sparks?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-sparks)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-sparks?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-sparks)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Zero-GC SoA spark and debris engine. Velocity stretching, floor bounce physics, thermodynamic OKLCH heat gradient. One dependency. 149 lines.

**[→ Live Interactive Playground](https://cdpn.io/pen/debug/LEReGXg)**

## Why lite-sparks?

| Feature | lite-sparks | tsparticles | fireworks-js | p5.js |
|---|---|---|---|---|
| **Zero-GC hot path** | **Yes** | No | No | No |
| **SoA flat arrays** | **Yes** | No | No | No |
| **Floor bounce** | **Yes (restitution)** | No | No | Manual |
| **Velocity stretching** | **Yes** | No | No | Manual |
| **Heat gradient** | **OKLCH thermodynamic** | RGB only | CSS only | Manual |
| **Sleep state** | **Yes** | No | No | No |
| **Seeded RNG (optional)** | **Yes** | No | No | No |
| **Dependencies** | **1** | 10+ | 0 | 0 |
| **Bundle size** | **< 2KB** | ~40KB | ~4KB | ~800KB |

## Installation

```bash
npm install @zakkster/lite-sparks
```

## Quick Start

```javascript
import { SparkEngine } from '@zakkster/lite-sparks';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const sparks = new SparkEngine(5000);

let w = canvas.width, h = canvas.height;
let last = performance.now();

function loop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);
    last = time;
    sparks.updateAndDraw(ctx, dt, w, h);
    requestAnimationFrame(loop);
}

// Burst: 50 sparks, upward cone, 200–800 px/s
canvas.addEventListener('click', (e) => {
    sparks.burst(e.clientX, e.clientY, 50, -Math.PI, 0, 200, 800);
});

requestAnimationFrame(loop);
```

---

## Spark Physics

### Thermodynamic Heat Gradient

Every spark starts white-hot and cools to cherry red as it dies. The default 4-stop gradient maps remaining life ratio to color:

| Life Ratio | Color | Temperature |
|---|---|---|
| 1.0 (just born) | `oklch(0.98, 0.05, 90)` | White-hot core |
| 0.7 | `oklch(0.85, 0.20, 70)` | Yellow |
| 0.4 | `oklch(0.60, 0.25, 30)` | Orange |
| 0.0 (dying) | `oklch(0.30, 0.20, 20)` | Cherry red |

The color index uses a precomputed `invLife[]` multiplier to avoid division in the render loop.

### Velocity Stretching

Each spark renders as a line from its current position to a tail point computed from velocity:

```
tailX = x - vx × stretch
tailY = y - vy × stretch
```

Fast sparks draw long lines. Slow sparks draw dots. The `stretch` config controls tail length. Higher stretch = longer comet trails.

### Floor Bounce (Restitution)

When a spark hits the floor (`y >= h`), it bounces:

```
vy *= -restitution    (reverse + energy loss)
vx *= floorFriction   (horizontal slowdown on contact)
```

When bounce velocity drops below 20 px/s, the spark stops bouncing and rests. When both axes drop below threshold, the spark enters **sleep state** — physics are completely bypassed, saving CPU for particles that have settled.

### Weight

Each spark gets a random `weight` (1.0–4.0) that controls `lineWidth`. Heavier sparks render as thicker strokes. Weight also offsets the floor position slightly so sparks don't all pile at the exact same Y.

---

## Full Config Reference

All config values are live-mutable between frames.

| Option | Type | Default | Description |
|---|---|---|---|
| `gravity` | number | 800 | Downward acceleration in px/s². Sparks are heavy — higher than fireworks. |
| `friction` | number | 0.99 | Air friction per frame (0–1). 0.99 = very light drag for fast sparks. |
| `floorFriction` | number | 0.85 | Horizontal friction on floor bounce. Lower = sparks skid further. |
| `restitution` | number | 0.4 | Bounce energy retention (0 = no bounce, 1 = perfect elastic). |
| `stretch` | number | 0.04 | Velocity tail multiplier. Higher = longer comet trails. |
| `transparentBackground` | boolean | false | `false` = additive blending (dark bg). `true` = source-over (light bg). |
| `heatColors` | Array | 4 OKLCH stops | Heat gradient. Index 0 = coldest (dying), last = hottest (born). Pre-parsed at construction. |
| `rng` | Function | `Math.random` | RNG function `() => number` in [0, 1). Inject seeded RNG for determinism. |

---

## Canvas Setup (No Built-in Resize — By Design)

lite-sparks is a pure engine — it doesn't own the canvas. Here's the recommended setup:

```javascript
import { SparkEngine } from '@zakkster/lite-sparks';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const sparks = new SparkEngine();

let w = 0, h = 0;
const dpr = window.devicePixelRatio || 1;

function updateSize() {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}

// RAF-debounced ResizeObserver
let scheduled = false;
new ResizeObserver(() => {
    if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; updateSize(); });
    }
}).observe(canvas.parentElement || document.body);

updateSize();

let last = performance.now();
function loop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);
    last = time;
    sparks.updateAndDraw(ctx, dt, w, h);
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

---

## Seeded Random (Deterministic Replays)

lite-sparks uses `Math.random` by default. For deterministic output, inject `@zakkster/lite-random`:

```javascript
import { SparkEngine } from '@zakkster/lite-sparks';
import { Random } from '@zakkster/lite-random';

const rng = new Random(42);
const sparks = new SparkEngine(5000, { rng: () => rng.next() });

// Same seed + same burst sequence = identical output
sparks.burst(400, 300, 50, -Math.PI, 0, 200, 800);

// Reset for replay
rng.reset(42);
sparks.clear();
sparks.burst(400, 300, 50, -Math.PI, 0, 200, 800); // exact same sparks
```

---

## Recipes

<details>
<summary><strong>🔥 Welding Arc (Continuous Stream)</strong></summary>

Hold mouse down for a constant upward spray of sparks, like a welding torch or angle grinder.

```javascript
const sparks = new SparkEngine(5000, { gravity: 600, restitution: 0.5, stretch: 0.05 });

let drawing = false, mx = 0, my = 0;
canvas.addEventListener('mousedown', () => drawing = true);
canvas.addEventListener('mouseup', () => drawing = false);
canvas.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });

function loop(time) {
    const dt = /* ... */;
    if (drawing) {
        // Wide upward cone, 15 sparks per frame
        sparks.burst(mx, my, 15, Math.PI + 0.5, Math.PI * 2 - 0.5, 200, 800);
    }
    sparks.updateAndDraw(ctx, dt, w, h);
    requestAnimationFrame(loop);
}
```

</details>

<details>
<summary><strong>💥 Impact Explosion (Single Burst)</strong></summary>

One massive radial burst on click — all angles, high speed, short life.

```javascript
const sparks = new SparkEngine(8000, { gravity: 1200, restitution: 0.3, stretch: 0.03 });

canvas.addEventListener('click', (e) => {
    sparks.burst(e.clientX, e.clientY, 300, 0, Math.PI * 2, 400, 1500, 0.3, 1.2);
});
```

</details>

<details>
<summary><strong>🫠 Molten Drip (Slow Heavy Slag)</strong></summary>

Slow, heavy particles dripping downward with long life and low bounce.

```javascript
const sparks = new SparkEngine(3000, {
    gravity: 400,
    restitution: 0.1,
    stretch: 0.08,
    friction: 0.995,
});

// Drip downward only (0 to π = below horizon)
setInterval(() => {
    sparks.burst(w / 2, 100, 5, 0, Math.PI, 10, 150, 1.0, 3.0);
}, 100);
```

</details>

<details>
<summary><strong>🎨 Custom Heat Gradient</strong></summary>

Replace the default gradient with brand colors or fantasy metals.

```javascript
const sparks = new SparkEngine(5000, {
    heatColors: [
        { l: 0.2, c: 0.15, h: 270 },  // cold: deep purple
        { l: 0.5, c: 0.25, h: 300 },  // warm: magenta
        { l: 0.7, c: 0.20, h: 330 },  // hot: pink
        { l: 0.95, c: 0.05, h: 0 },   // white-hot: near white
    ],
});
```

</details>

<details>
<summary><strong>☀️ Light Mode (Source-Over Blending)</strong></summary>

On light backgrounds, disable additive blending so sparks render with proper opacity.

```javascript
const sparks = new SparkEngine(5000, {
    transparentBackground: true,
});

// Toggle at runtime
modeToggle.onchange = () => {
    sparks.config.transparentBackground = modeToggle.checked;
};
```

</details>

<details>
<summary><strong>🎛️ Live Config Panel</strong></summary>

All config values are live-mutable — perfect for debug panels.

```javascript
gravitySlider.oninput = () => sparks.config.gravity = +gravitySlider.value;
restitutionSlider.oninput = () => sparks.config.restitution = +restitutionSlider.value;
stretchSlider.oninput = () => sparks.config.stretch = +stretchSlider.value;
```

</details>

---

## API

### `new SparkEngine(maxParticles?, config?)`

Creates a spark engine with a pre-allocated SoA particle pool.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxParticles` | number | 5000 | Pool capacity. Ring buffer behavior. |
| `config` | SparkConfig | see above | All options. Live-mutable after construction. |

### Methods

| Method | Description |
|---|---|
| `.burst(x, y, count, angleMin, angleMax, speedMin, speedMax, lifeMin?, lifeMax?)` | Spawn sparks in an angular cone. Angles in radians. |
| `.updateAndDraw(ctx, dt, w, h)` | Physics + render. `dt` in seconds. `h` is floor Y. |
| `.clear()` | Kill all particles immediately. |
| `.destroy()` | Null all typed arrays. Idempotent. |

### burst() Angle Guide

```
          -π/2 (straight up)
            │
   -π ──────┼────── 0 (right)
   (left)   │
          π/2 (straight down)
```

Common cones:
- **Upward fan:** `angleMin = -Math.PI, angleMax = 0`
- **Full radial:** `angleMin = 0, angleMax = Math.PI * 2`
- **Downward drip:** `angleMin = 0, angleMax = Math.PI`
- **Right spray:** `angleMin = -0.5, angleMax = 0.5`

---

## License

MIT

## Part of the @zakkster ecosystem

Zero-GC, deterministic, tree-shakeable micro-libraries for high-performance web presentation.
