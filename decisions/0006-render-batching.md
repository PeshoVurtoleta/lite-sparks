# 0006 -- Batched render: counting-sort into (color, width) bins, 1-4px width quantization

- Status: accepted
- Date: 2026-08-15
- Session: S3 (v1.2.0)
- Finding: S-07

## Context

Through v1.1.0 the render loop issued a full stroke pipeline **per particle**:

```js
ctx.beginPath();
ctx.moveTo(x, y);
ctx.lineTo(tailX, tailY);
ctx.lineWidth = this.weight[i];
ctx.strokeStyle = this.colors[colorIdx];
ctx.stroke();
```

For a full pool that is one `beginPath`/`lineWidth`/`strokeStyle`/`stroke` per
live spark -- up to `maxParticles` (2000+) stroke submissions per frame, each
flushing a one-segment path and re-setting two pieces of context state. Canvas2D
state changes and path flushes are the throughput ceiling; the actual line
geometry is trivial by comparison.

The two pieces of per-particle state have tiny ranges: `strokeStyle` is one of
`colors.length` gradient stops (4 by default) and `lineWidth` is a float in
`[1, 4)`. That is at most `colors.length x 4 = 16` distinct (color, width) pairs,
so at most 16 state configurations are ever needed for a whole frame.

## Decision

Group the frame into `colors.length x 4` **bins** keyed by
`colorIdx * 4 + wBucket` and stroke one batched path per non-empty bin, setting
`strokeStyle`/`lineWidth` once per bin. The grouping is a **two-phase counting
sort** over persistent `Int32Array` scratch (`_order`, `_binCount`, `_binStart`),
allocated once in the constructor and reused every frame:

1. **Phase 1 -- physics + count.** The existing per-particle physics/cull loop,
   with all invariants hoisted to preheader locals (S-09). For each surviving
   spark, compute `colorIdx` and increment `_binCount[colorIdx*4 + wBucket]`.
2. **Phase 2 -- prefix + scatter.** Exclusive prefix-sum `_binCount` into
   `_binStart` (per-bin start offsets), then scatter each survivor's index into
   `_order` at its bin cursor. `_binStart[nbins]` is the total drawable count.
3. **Phase 3 -- stroke.** For each non-empty bin, set `strokeStyle`/`lineWidth`
   once and stroke a single path holding all of the bin's segments.

Stroke submissions drop from O(alive) to O(non-empty bins) <= 16.

### Width quantization -- `wBucket` in {0..3}, drawn at 1-4px

`lineWidth` cannot be a per-particle float and still collapse into a bounded bin
count, so width is **quantized at spawn** (cold path) into four buckets:

```js
let wb = (weight - 1) | 0;      // weight in [1,4) -> {0,1,2}
wb = wb < 0 ? 0 : wb > 3 ? 3 : wb;
this.wBucket[i] = wb;           // stored in a Uint8Array column
```

and the render draws bucket `b`'s bin at integer width `(b & 3) + 1`, i.e. 1, 2,
3 or 4px. The quantization is computed **once at spawn** and never in the hot
loop.

### Does 1-4px quantization read as banding?

No. The pre-quantization widths were already a narrow `[1, 4)` float range on
1-4px lines with `lineCap: 'round'`; snapping each spark to the nearest integer
px moves an endpoint cap by at most half a pixel. Against additive `'lighter'`
compositing and per-frame heat-color cooling, sub-pixel width steps are not
perceptible -- the eye tracks the color gradient and the velocity-stretched tail
length, not hairline width. Bench-confirmed: no visible banding at 1-4px. Were a
future palette to demand finer width control, the bucket count is a single
constant (`* 4`) to widen.

### The reordering is invisible to color/width, visible only to overdraw

The counting sort reorders draw calls **within** each equal-(color, width) bin
and across bins (all of bin 0, then all of bin 1, ...). Every spark still draws
exactly once, at its own byte-identical head/tail endpoints (the physics and the
`stretch` tail math are unchanged from v1.1.0). What changes is the **order** in
which overlapping segments are painted. Under additive `'lighter'` compositing
addition is commutative, so overdraw order is invisible there; under
`'source-over'` a different spark's pixels may land on top in a dense overlap.
This is an accepted, documented cosmetic difference -- no spark is dropped,
duplicated, or moved.

Critically: the SoA columns (`x/y/vx/vy/life/invLife/weight/state`) are **never
reordered**. Only the index list `_order` is sorted; the particle data stays in
place, so slot identity and every metamorphic/determinism law are untouched.

## Consequences

- Stroke submissions per frame: O(alive) (up to 2000+) -> <= `colors.length*4`
  (16 at the default palette). One `beginPath`/`stroke` and one
  `strokeStyle`/`lineWidth` set per non-empty bin.
- Two full particle passes (count, then scatter) instead of one, plus a
  `nbins`-length prefix pass. The extra pass is cheap arithmetic over
  already-hot SoA columns; the win is removing thousands of Canvas2D state
  changes and path flushes.
- Zero new allocation: `_order` (length `max`), `_binCount`/`_binStart` (length
  `nbins+1`) are constructor-allocated and reused; `_binCount` is cleared with an
  in-place fill each frame. Torture T6 pins all 12 backing-store `byteLength`s.
- Head/tail endpoints are byte-identical to v1.1.0; only per-particle `lineWidth`
  (now bucket-quantized) and overdraw order differ.

## Rejected alternatives

- **Sort the SoA columns themselves.** Rejected: reordering `x/y/vx/vy/...` would
  break slot identity, the determinism law, and would cost `max`-sized moves per
  frame. Sorting an index list is O(alive) writes into a persistent `_order`.
- **Keep per-particle `lineWidth` (float), bin only by color.** Rejected: color-
  only binning still sets `lineWidth` per particle, so the inner loop keeps a
  per-spark state change -- the batching would be half-done. Quantizing width is
  what collapses the frame to <= 16 fully-batched passes.
- **Build the bins with per-frame arrays / a Map.** Rejected: any per-frame
  container allocation fails the zero-GC law. The counting sort needs only three
  pre-allocated integer arrays.
