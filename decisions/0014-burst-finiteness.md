# 0014 -- burst() coerces its six cone/speed/life args to finite at entry; fail closed, valid input skips the door byte-identically

- Status: accepted
- Date: 2026-08-21
- Session: S6 (v1.4.1)
- Finding: S-16

## Context

Every other path into the pool is already finiteness-guarded. The S-01 dt door
(ADR pre-0007) rejects a hostile `dt`; the S-02 count door floors a hostile
`count` to a no-op; the S-13/S-14/S-15 config doors coerce every non-finite
knob (`wind`, `attract`, `scaleTo`, ...) ONCE in the cold constructor so the hot
loop never sees `NaN`. One door was still open: the six positional cone/speed/
life arguments to `burst()` itself -- `angleMin`, `angleMax`, `speedMin`,
`speedMax`, `lifeMin`, `lifeMax`.

They were unvalidated. A hostile arg is the S-01 whole-pool poison class through
the `burst()` door:

```js
const angle = angleMin + rng() * (angleMax - angleMin); // angleMin = NaN -> NaN
vxs[i] = Math.cos(angle) * speed;                       // cos(NaN) -> NaN
vys[i] = Math.sin(angle) * speed;                       // sin(NaN) -> NaN
```

`angleMin = NaN` (or `speedMax = Infinity`, whose `speedMax - speedMin` is
`Infinity` and `Infinity * finite` stays `Infinity` -- but a range straddling
`Infinity - Infinity` is `NaN`) NaN-poisons the vx/vy of every spark this burst
spawns. `aliveFinite` flips false the instant the physics loop reads them. This
was documented but ACCEPTED as a gap by the S5 vocabulary suite (the partial-
preset test pinned `sawNonFinite === true`); S6 closes it.

The constraint is the release invariant: a VALID (all-finite) burst must be
byte-identical to before -- the coercion must not touch the rng sequence or any
of the fifteen committed torture fingerprints.

## Decision

Coerce each of the six scalars with `Number.isFinite`, ONCE, at `burst()` entry
-- AFTER the S-02 count door confirmed there is work to do, BEFORE the
per-particle spawn loop reads them:

```js
count = count >= 1 ? (count | 0) : 0;
if (count === 0) return;

if (!Number.isFinite(angleMin)) angleMin = 0;
if (!Number.isFinite(angleMax)) angleMax = 0;
if (!Number.isFinite(speedMin)) speedMin = 0;
if (!Number.isFinite(speedMax)) speedMax = 0;
if (!Number.isFinite(lifeMin)) lifeMin = 0.5;
if (!Number.isFinite(lifeMax)) lifeMax = 1.5;

const max = this.max;
```

### Cold path, zero hot bytes, valid input untouched

The block sits in the cold entry of `burst`, guarded behind the count door, so a
no-op burst (`count < 1`) never reaches it and a real burst pays six
`Number.isFinite` checks ONCE per call, not once per spark. The per-particle
spawn loop and `updateAndDraw` are byte-identical -- no operand in a hot body
changed. Zero rng draws: the coercion reads and writes only the six stack args.
A VALID burst passes all six `isFinite` checks and mutates nothing, so its rng
sequence and every committed fingerprint are bit-identical (the torture suite's
fifteen hashes are the proof, gated in T0).

### Each min/max coerced INDEPENDENTLY

A half-NaN range is not "off" -- it is a real range with one hostile end, and the
sane end must survive. `speedMin = 200, speedMax = NaN` becomes `200 -> 0`
(coercing only the NaN end), a real `[0, 200]` reversed range the spawn handles,
not a whole-range reset. Coercing the pair together (e.g. "if either is NaN, zero
both") would discard a caller's good value on the strength of a bad neighbour.

### Fail-closed fallbacks, not guesses

- **angle -> 0** is +x, a DEFINITE direction (canvas 0 rad points right), not an
  invented cone. A NaN-angled burst fires flat right rather than vanishing.
- **speed -> 0** rides the existing S-05 epsilon: a spawn with `vx === vy === 0`
  already gets a tiny `vy = 1e-3` seeded so gravity engages, so a NaN speed
  becomes a spark that falls under gravity -- a dying ember, not a frozen NaN and
  not an invisible no-op. The fallback reuses a guard that already exists.
- **lifeMin -> 0.5 / lifeMax -> 1.5** are the DOCUMENTED positional defaults of
  the `burst` signature. A non-finite life falls back to exactly the value the
  caller would have gotten by omitting the argument -- the least surprising
  choice, and one the S-11 clamp already backstops.

### S-11 clamp flipped to the NaN-safe form

The spawn life clamp `if (life < 1e-4) life = 1e-4;` becomes
`if (!(life >= 1e-4)) life = 1e-4;` -- same instruction count. `life < 1e-4` is
`false` for `NaN`, so a non-finite life that somehow reached the clamp would pass
through; `!(life >= 1e-4)` is `true` for `NaN`, so it clamps. With the entry door
coercing `lifeMin`/`lifeMax`, a `NaN` life is already unreachable here -- but the
`!(>=)` form is a second, free door on the same hazard (defence in depth, the
fail-closed law).

## Consequences

- `burst()` is now finiteness-guarded on all nine of its arguments (`x`/`y` are
  positions, not read into arithmetic that can poison the pool; `count` is the
  S-02 door; the six cone/speed/life args are this door). The last open path into
  the pool is closed.
- A hostile-args burst now yields a finite, deterministic snapshot. The torture
  T0 `BURST_HOSTILE` fingerprint pins it and asserts it differs from
  `AERO_OFF_HASH` (the door did something); T1 adds eighteen hostile lanes
  (each of the six args in {NaN, +Inf, -Inf}) asserting `aliveFinite` and an
  exact `aliveCount`; T9 Control I replays the spawn WITHOUT the coercion and
  asserts `aliveFinite` FAILS, so the gate is provably able to fail.
- No new public API, no signature change, patch release. The fifteen committed
  fingerprints are bit-identical (valid input skips the door).
- The S5 vocabulary suite's partial-preset test flips: `burstPreset(e, x, y,
  { count: 5 })` (a partial preset with `undefined` angle/speed) now FAILS
  CLOSED -- all live vx/vy finite -- because the `undefined` args coerce to 0
  through this door. The gap that test pinned is closed.

## Rejected alternatives

- **Coerce in the constructor like the config knobs.** REJECTED -- these are
  per-call arguments, not stored config. There is no persistent slot to sanitize
  once; the only place a `burst` arg exists is the `burst` call itself, so that
  is where the door belongs.
- **Validate in `burstPreset`/`makeEmitter` instead of `burst`.** REJECTED. The
  poison enters through `engine.burst`, the public core primitive; guarding only
  the two authoring helpers would leave the raw API open and duplicate the check
  in every future caller. One door at the choke point covers every path.
- **Throw on a non-finite arg.** REJECTED -- inconsistent with the whole engine's
  fail-closed identity (a bad `dt`, `count`, or config knob is a silent no-op or
  a coerced default, never a throw). A burst is a fire-and-forget VFX call in a
  hot RAF loop; throwing would crash a frame over a bad number the caller cannot
  easily trace. Coerce to a sane default and keep drawing.
- **Coerce the pair together (zero both min and max if either is NaN).**
  REJECTED. It discards a caller's good value on the strength of a bad neighbour;
  independent coercion keeps the sane end of a half-hostile range.
- **A hot-body guard per spark.** REJECTED -- it would add bytes to the
  per-particle spawn loop for a check that is invariant across the whole burst.
  The cold entry check is once per call; the loop stays byte-identical.

Note: "finite" here means IEEE-finite (`Number.isFinite`), not bounded -- a
legitimately astronomical-but-finite arg (e.g. `speedMax=1e308, speedMin=-1e308`)
can still overflow `speedMax - speedMin` to `Infinity`, which downstream is the
same `Infinity * finite` poison the door was built to keep out. That is
out of scope for the NaN/Infinity poison class S-16 targets and is a
pre-existing property of the range arithmetic (`max - min`), not a regression
introduced by this door.
