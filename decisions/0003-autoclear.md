# 0003 -- `autoClear` defaults to true; the `transparentBackground` rename is parked to 2.0

- Status: accepted
- Date: 2026-08-15
- Session: S2 (v1.1.0)
- Finding: S-03

## Context

v1.0.2 called `ctx.clearRect(0, 0, w, h)` unconditionally at the top of
`updateAndDraw`, in both compositing modes, before the `transparentBackground`
branch. Sparks are velocity-stretched lines, not accumulating bloom dots, so a
full wipe every frame is the correct default for a standalone spark canvas.

But the wipe is also what makes the engine unusable for the integrations it
exists for. Every frame it destroys whatever the caller drew: a game world, a
scratch surface a pointer is dragging sparks across, a fireworks/smoke layer the
sparks should sit on top of. There is no way to ask the engine to *add* to an
existing frame -- the layering the package is marketed for is impossible.

## Decision

Add a config key `autoClear`, default `true`, and guard the clear:

```js
if (this.config.autoClear) ctx.clearRect(0, 0, w, h);
```

- Default `true` preserves v1.0.2 behavior **exactly** -- the clear fires on
  every frame, byte-identical to before. Existing callers see no change.
- `autoClear:false` skips the clear, so the engine draws its sparks over whatever
  is already on the canvas. The caller owns clearing (or deliberately does not,
  to accumulate a trail on a surface it manages).

This is confetti's / a compositor's separation of concerns: the particle engine
renders particles; the frame lifecycle (clear, present) belongs to whoever owns
the canvas. Default-true keeps the batteries-included single-canvas path working
with zero config; false hands the lifecycle back for layering.

### Why default true, not false

Default false would be the more "composable" default, but it silently breaks
every current single-canvas caller (their sparks would smear into solid blocks
of `lighter`-blended color within a few frames) -- a silent behavior change on a
minor version. Fail closed on compatibility: the default must reproduce the old
output bit-for-bit, and the new capability is strictly opt-in. A caller who wants
layering is already writing integration code and can set one flag.

### The `transparentBackground` semantic inversion is a known trap, parked to 2.0

`transparentBackground` here selects the **compositing operation**, not a clear
policy: `true` -> `source-over` (light backgrounds), `false` -> `lighter`
(additive, dark backgrounds). In the sibling `lite-fireworks`, a same-named
option means the opposite thing (whether the background is wiped / see-through).
A developer moving between the two packages will reasonably assume they match and
be wrong.

Renaming `transparentBackground` (e.g. to `blendMode` / `additive`) is a breaking
change to a shipped public option and belongs in a major bump. It is explicitly a
**Non-goal** for S2 (roadmap). For 1.1.0 the mitigation is documentation: both
READMEs and `llms.txt` call out the inversion as a cross-package trap. The rename
is parked to 2.0.

## Consequences

- Default `autoClear:true` -> the clear fires exactly once per frame; a recording
  ctx pins the call count (torture T0 law 5, `test`-level companion possible).
- `autoClear:false` -> `clearRect` is never called; prior pixels survive between
  engine strokes. Pointer-scratch and fireworks/smoke layering are now possible.
- Cold-path cost: a single boolean branch at the top of `updateAndDraw`, outside
  the per-particle loop. The hot body is untouched.
- Unresolved: the `transparentBackground` naming collision with lite-fireworks
  stands until a 2.0 rename. Documented, not silenced.

## Rejected alternatives

- **Default `autoClear:false`.** Rejected: silently breaks every single-canvas
  caller on a minor bump. The default must be byte-identical to v1.0.2.
- **Rename `transparentBackground` now.** Rejected: breaking change to a shipped
  option; belongs in 2.0 (roadmap Non-goal). Mitigated by docs for 1.1.0.
- **A separate `clear()`-per-frame method instead of a flag.** Rejected: the
  engine still owns the clear either way; a flag is one branch and keeps the
  single-call `updateAndDraw` API. A method split adds surface for no gain.
