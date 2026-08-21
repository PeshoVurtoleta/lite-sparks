# 0013 -- scaleTo/fadeOut ride one hoisted `if (enveloped)` render gate; off by default, the batched lane is byte-identical

- Status: accepted
- Date: 2026-08-21
- Session: S5 (v1.4.0)
- Finding: S-15

## Context

The S5 wave asks for per-particle life envelopes: a spark that thins as it cools
(`scaleTo`) and one that fades out as it dies (`fadeOut`), so an ember can shrink
to a dim thread instead of vanishing at full width. Both are functions of the
spark's remaining life, distinct per spark within the same color/width bin.

This collides head-on with the S-07 render design (ADR 0006). The batched lane
sets `strokeStyle` + `lineWidth` ONCE per (color, width) bin and strokes every
spark in that bin as a single path -- one state change amortized over hundreds of
segments. A per-spark width or alpha CANNOT be expressed in that lane: two sparks
in the same bin now want different widths and different alphas, which is one
`lineWidth`/`globalAlpha` set + one `stroke` PER SPARK. The batched lane's whole
value is that it does not do that.

The constraint is the usual one: the default (no envelope) path must stay
byte-identical to v1.3.1's batched render, and turning the feature on must not
poison the pool through the config door.

## Decision

One preheader gate `enveloped`, and two render lanes selected by it. The batched
lane is unchanged; the enveloped lane is a separate per-particle branch.

### One gate, hoisted, false at the default

```js
const scaleTo = cfg.scaleTo;
const fadeOut = cfg.fadeOut;
const enveloped = scaleTo !== 1 || fadeOut !== 0;
```

`enveloped` is `false` when `scaleTo === 1` and `fadeOut === 0` (the defaults), so
the render phase takes the ELSE branch -- the v1.3.1 bin-batched lane, byte-for-
byte. The feature costs one hoisted disjunction and nothing else when off.

### The enveloped lane draws the SAME geometry, one stroke per spark

```js
if (enveloped) {
    for (let b = 0; b < nbins; b++) {
        const start = binStart[b], end = binStart[b + 1];
        if (end === start) continue;
        ctx.strokeStyle = colors[b >> 2];
        for (let k = start; k < end; k++) {
            const i = order[k];
            const hx = xs[i], hy = ys[i];
            const prog = lifeA[i] * invLifeA[i];   // remaining-life ratio [0,1]
            ctx.lineWidth = weightA[i] * (scaleTo + (1 - scaleTo) * prog);
            ctx.globalAlpha = 1 - fadeOut * (1 - prog);
            ctx.beginPath();
            ctx.moveTo(hx, hy);
            ctx.lineTo(hx - vxs[i] * stretch, hy - vys[i] * stretch);
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;
}
```

- **Same segment geometry.** Head `(hx, hy)` to `(hx - vx*stretch, hy -
  vy*stretch)` -- identical to the batched lane's endpoints. Only the width, the
  alpha, and the one-stroke-per-spark batching differ. The batched lane's
  endpoints ARE the spec; the enveloped lane reproduces them exactly.
- **Envelope from the existing columns, 0 rng.** `prog = lifeA[i] * invLifeA[i]`
  is the remaining-life ratio the render already computes for the color index --
  no new column, no random draw. Width scales `1 -> scaleTo` and alpha fades
  `1 -> 1-fadeOut` as `prog` runs from 1 (fresh) to 0 (dying). Deterministic.
- **Still bin-grouped for color.** The lane iterates the SAME `order`/`binStart`
  scatter, so `strokeStyle` is still set once per non-empty color bin; only the
  width/alpha/stroke are per spark. This keeps the color-state changes batched
  even in the envelope lane.
- **Fail-closed restore.** The enveloped lane is the only writer of
  `globalAlpha`; it resets it to `1` after the loop so the next frame (or a
  caller drawing over the canvas) never inherits a stale alpha. The T9
  forgot-restore control proves the restore is load-bearing.

### Fail closed on the config door -- the NaN trap

`enveloped` is a `!== 1` / `!== 0` disjunction, and `NaN !== 1` and `NaN !== 0`
are BOTH `true`. So a `scaleTo = NaN` or `fadeOut = NaN` would flip the enveloped
lane ON and then feed `lineWidth = weight * NaN` / `globalAlpha = NaN` to every
stroke -- the S-01 poison class through the config door, exactly the hazard the
air/vortex knobs close (ADR 0008/0010). Both are coerced once in the cold
constructor BEFORE any hot read (`scaleTo` NaN -> 1, `fadeOut` NaN -> 0), so a
NaN knob collapses to the OFF default and the batched lane is taken. The torture
suite pins this directly: a NaN scaleTo/fadeOut does not select the enveloped
lane.

## Consequences

- Off by default: one hoisted `enveloped` compare; the render is the v1.3.1
  batched lane, byte-identical. The eight committed fingerprints are unchanged
  (the envelope touches render only, not the physics columns the hashes read).
- On: the render drops from `<= nbins` stroke passes to one stroke per live
  spark -- the batching tradeoff. This is the explicit cost of a per-particle
  envelope and is why it is opt-in: a caller who wants uniform sparks keeps the
  cheap batched lane. Zero ALLOCATION in either lane (torture T6 enveloped lane
  pins all twelve backing stores unchanged, maxMajor 0).
- No new SoA column: the envelope reuses `life`/`invLife`/`weight`.

## Rejected alternatives

- **Bake the envelope into the batched lane.** REJECTED -- impossible without
  losing the batch: per-spark width and alpha require a `lineWidth`/`globalAlpha`
  set + `stroke` per spark, which is exactly the one-draw-per-particle the S-07
  batching exists to avoid. The two are fundamentally different render strategies;
  the gate selects between them rather than compromising the fast default.
- **Always run the per-particle lane and set width/alpha to identity when off.**
  REJECTED. It would make every default render pay the per-spark stroke cost and
  abandon the batched lane for everyone, a regression for the common case to
  serve the opt-in one. The gate keeps the default fast.
- **A new per-spark alpha/scale SoA column filled at spawn.** REJECTED. The
  envelope is a pure function of remaining life, which the render already has in
  `life * invLife`; a stored column would be redundant state and a new buffer to
  pin. Deriving it costs one multiply per spark in the lane that is already
  per-spark.
- **Not restoring `globalAlpha`.** REJECTED. A stale alpha leaks into the next
  frame's clear/composite and into any caller drawing on the shared canvas. The
  `= 1` restore is fail-closed; the T9 control proves omitting it is caught.
