# 0011 -- makeEmitter carries a fractional spark accumulator; step() spawns the integer part and keeps the remainder

- Status: accepted
- Date: 2026-08-21
- Session: S5 (v1.4.0)
- Finding: S-15

## Context

The S5 "debris vocabulary" wave adds an authoring layer over the raw
`burst`/`updateAndDraw` core. One piece is a continuous emitter: a source that
drips sparks over time at a caller-set rate, so a torch, a sparking wire, or an
ember bed can be expressed as "N sparks per second" instead of a hand-rolled
per-frame `burst` with a manual counter.

The rate is a real number of sparks PER SECOND, but `burst` only spawns an
integer count and a frame's `dt` is small (~1/60 s). A naive `engine.burst(x, y,
rate * dt, ...)` truncates: at rate 100/s and dt 1/60, `rate*dt` is 1.667, which
`burst`'s `count|0` floors to 1 every frame -- 60/s, not 100/s. Any rate whose
per-frame contribution is not a whole number loses its fraction every single
frame. lite-confetti solved the same shape with an INTEGER rate (whole particles
per tick); a spark torch wants a smooth continuous rate, so the fraction must be
preserved, not truncated.

This is a cold authoring helper, but its `step` runs once per frame per emitter,
so it lives under the same hot-path law as the engine: zero allocation per step,
fail closed on hostile input.

## Decision

`makeEmitter(opts)` returns a plain descriptor holding a `carry` accumulator.
`step(engine, dt)` adds `rate * dt` sparks-worth of fractional credit, spawns the
integer part, and keeps the remainder for the next step.

```js
step(engine, dt) {
    if (!(dt > 0) || !(this.rate > 0)) return;
    this.carry += this.rate * dt;
    const n = this.carry | 0;   // integer sparks to emit this step
    this.carry -= n;            // keep the fractional remainder
    if (n > 0) {
        engine.burst(
            this.x, this.y, n,
            UP - this.cone, UP + this.cone,
            this.speed * 0.5, this.speed,
            this.life * 0.5, this.life
        );
    }
}
```

### The carry accumulator, not an integer rate

Over many steps `sum(n)` converges on `sum(rate * dt)` exactly, because every
fraction that `| 0` drops this step is retained in `carry` and paid on a later
step. At rate 100/s and dt 1/60 the carry crosses an integer boundary on ~5 of
every 3 frames, so the emitter emits 1 or 2 sparks per frame and averages exactly
100/s -- the smooth continuous rate the caller asked for. An integer-per-frame
emitter (lite-confetti's model) would floor to 60/s and silently drop 40% of the
sparks. The contrast is the whole reason this helper exists.

### Zero allocation per step

`step` reads only stored scalar fields (`this.x`, `this.rate`, ...) and computes
the derived cone/speed/life burst arguments as stack expressions passed straight
into `engine.burst` positionally -- no temp object, no array, no spread. The
descriptor itself is allocated ONCE at construction (a cold call); stepping it
forever allocates nothing. The torture T6 emitter-step lane pins all twelve
backing stores unchanged and gates a major GC.

### Fail closed at construction AND in step

Construction coerces a non-finite/negative `rate`, `speed`, or `life` to `0` (an
inert emitter that spawns nothing) and a non-finite `x`, `y`, or `cone` to `0`.
`step` additionally guards `!(dt > 0) || !(this.rate > 0)` and returns: this
catches a `NaN`/negative `dt` from the caller's clock AND a `rate` a caller
mutated to `NaN` after construction. Without the `dt` guard a `NaN` dt would make
`this.carry += NaN` and poison the accumulator FOREVER -- every subsequent step
would spawn nothing (`NaN | 0` is 0) even after dt recovered. The guard makes a
bad frame a no-op, mirroring the engine's S-01 dt door.

## Consequences

- A continuous source is one descriptor + one `step` call per frame; the caller
  owns the loop and the engine, exactly like the core (no canvas ownership, no
  hidden RAF). Multiple emitters compose by stepping each.
- The rate is honoured to the fraction over time, so a slow ember bed (rate 3/s,
  ~1 spark every 20 frames) works as well as a torch (rate 400/s).
- Zero allocation per step (torture T6 emitter lane) and a bad-dt step is a
  no-op that cannot poison the carry (torture T9 hostile-emitter control).
- The cone is a half-spread around straight up (`UP = -TAU/4`); speed/life are
  spread 0.5x..1x of the set value. These are cold constants, committed so the
  torture EMITTER_HASH is stable.

## Rejected alternatives

- **An integer `rate` (lite-confetti's model).** REJECTED for a continuous
  source: it cannot express a sub-frame rate without truncating the fraction away
  every frame. Confetti bursts in discrete puffs; a spark torch is a smooth
  stream. The carry accumulator is the minimal change that keeps the average
  exact.
- **`burst(rate * dt)` with no accumulator.** REJECTED -- this IS the truncation
  bug: `count | 0` inside `burst` floors the fractional per-frame contribution to
  0 or 1, so the emitted rate is quantized to whole sparks per frame.
- **An emitter that owns its own timer / RAF.** REJECTED. The engine deliberately
  takes `(ctx, dt, w, h)` and owns no clock (no canvas ownership); an emitter
  that started a timer would break that contract and leak a timer the caller
  cannot see. `step(engine, dt)` keeps the caller in control of the loop.
- **A class with a prototype `step`.** REJECTED as unnecessary: a single frozen
  descriptor shape with a method is enough, and the plain-object form keeps the
  helper a few lines in the single main file (single-file law).
