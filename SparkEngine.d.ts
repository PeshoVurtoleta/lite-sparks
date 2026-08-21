/**
 * @zakkster/lite-sparks -- TypeScript Declarations
 */

/** Package version string, kept in sync with package.json. */
export declare const VERSION: string;

export interface SparkConfig {
    /** Downward acceleration in px/s^2. Default: 800 */
    gravity?: number;
    /** Air friction, dt-independent (applied as pow(friction, dt*60)). Default: 0.99 */
    friction?: number;
    /** Horizontal friction applied on floor bounce. Default: 0.85 */
    floorFriction?: number;
    /** Bounce energy retention (0 = no bounce, 1 = perfect). Default: 0.4 */
    restitution?: number;
    /** Velocity-direction tail stretch multiplier. Default: 0.04 */
    stretch?: number;
    /** Alias for `friction`: when non-null it overrides friction (null is not zero). Default: null */
    drag?: number | null;
    /** Constant horizontal air push in px/s^2 (+ is rightward). 0 disables the wind term. Default: 0 */
    wind?: number;
    /** Gust amplitude in px/s^2: a sin oscillation at TAU/3 rad/s (3s period) added to wind. 0 disables it. Default: 0 */
    gust?: number;
    /** Turbulence amplitude in px/s^2: a per-spark curl seeded by invLife. 0 disables it. Default: 0 */
    turbulence?: number;
    /** Left wall X: a moving spark is clamped to x >= wallLeft and its inward vx reflected. null = no wall (null is not zero). Default: null */
    wallLeft?: number | null;
    /** Right wall X: a moving spark is clamped to x <= wallRight and its inward vx reflected. null = no wall. Default: null */
    wallRight?: number | null;
    /** Ceiling Y: a moving spark is clamped to y >= ceiling and its inward vy reflected. null = no ceiling. Default: null */
    ceiling?: number | null;
    /** Vortex radial pull toward (attractX, attractY) in px/s^2; negative repels. Clamped per-axis to +/-4000. 0 disables it. Default: 0 */
    attract?: number;
    /** Vortex tangential (swirl) push perpendicular to the radius in px/s^2. Clamped per-axis to +/-4000. 0 disables it. Default: 0 */
    swirl?: number;
    /** Vortex center X. Read only when attract/swirl is non-zero. Default: 0 */
    attractX?: number;
    /** Vortex center Y. Read only when attract/swirl is non-zero. Default: 0 */
    attractY?: number;
    /**
     * Floor-contact hook, called with primitives only when a spark bounces AND its
     * PRE-bounce downward speed exceeds `onBounceMinSpeed`. Receives (x, post-bounce
     * vx, weight). It MUST NOT throw (there is no try/catch -- a throw surfaces) and
     * MUST NOT mutate the engine mid-frame. A non-function coerces to null. null = no
     * hook (null is not zero). Default: null
     */
    onBounce?: ((x: number, vx: number, weight: number) => void) | null;
    /** Minimum PRE-bounce downward speed (px/s) for onBounce to fire; a gentle settle below it is silent. Non-finite -> 0. Default: 0 */
    onBounceMinSpeed?: number;
    /** Per-particle line-width multiplier reached at end of life (1 = no scale). Non-1 enables the enveloped render lane. Non-finite -> 1. Default: 1 */
    scaleTo?: number;
    /** Per-particle alpha reduction reached at end of life (0 = opaque, 1 = fully faded). Non-0 enables the enveloped render lane. Non-finite -> 0. Default: 0 */
    fadeOut?: number;
    /** true = source-over (light bg), false = additive 'lighter' (dark bg). Default: false */
    transparentBackground?: boolean;
    /** true wipes the canvas each frame; false draws over existing pixels (layer over a game/scratch surface). Default: true */
    autoClear?: boolean;
    /** Landing floor Y. null uses the h passed to updateAndDraw (null is not zero). Default: null */
    floorY?: number | null;
    /** Heat gradient: array of OKLCH objects or CSS strings. Index 0 = coldest (dying). Default: 4-stop cherry -> orange -> yellow -> white */
    heatColors?: Array<{ l: number; c: number; h: number } | string>;
    /** Random number generator () => number [0, 1). Default: Math.random */
    rng?: () => number;
}

export declare class SparkEngine {
    readonly max: number;
    config: Required<SparkConfig>;
    colors: string[];

    x: Float32Array | null;
    y: Float32Array | null;
    vx: Float32Array | null;
    vy: Float32Array | null;
    life: Float32Array | null;
    invLife: Float32Array | null;
    weight: Float32Array | null;
    state: Uint8Array | null;
    /** Per-spark width bucket {0..3}, quantized at spawn for the batched render. */
    wBucket: Uint8Array | null;

    constructor(maxParticles?: number, config?: SparkConfig);

    /**
     * Spawn a burst of sparks at (x, y) within an angular cone.
     *
     * S-16 (v1.4.1) finiteness door: the six cone/speed/life args are each
     * coerced independently with Number.isFinite at entry, so a hostile
     * NaN/Infinity value fails closed instead of NaN-poisoning the pool. A
     * non-finite angleMin/angleMax -> 0, speedMin/speedMax -> 0 (a zero speed
     * rides the S-05 epsilon and falls under gravity), lifeMin -> 0.5 /
     * lifeMax -> 1.5 (the documented defaults). Valid (all-finite) bursts skip
     * the coercion, so the seeded rng sequence is untouched.
     * @param x         Origin X
     * @param y         Origin Y
     * @param count     Number of sparks to spawn (< 1, NaN, or Infinity spawn 0; floored to an integer)
     * @param angleMin  Emission cone start (radians; non-finite -> 0)
     * @param angleMax  Emission cone end (radians; non-finite -> 0)
     * @param speedMin  Minimum launch speed (px/s; non-finite -> 0)
     * @param speedMax  Maximum launch speed (px/s; non-finite -> 0)
     * @param lifeMin   Minimum lifetime (seconds). Default: 0.5 (non-finite -> 0.5)
     * @param lifeMax   Maximum lifetime (seconds). Default: 1.5 (non-finite -> 1.5)
     */
    burst(
        x: number, y: number, count: number,
        angleMin: number, angleMax: number,
        speedMin: number, speedMax: number,
        lifeMin?: number, lifeMax?: number
    ): void;

    /**
     * Update physics and render all particles. Call once per frame.
     * A non-finite or non-positive dt is a silent no-op frame (fail closed).
     * @param ctx Canvas 2D context
     * @param dt  Delta time in seconds
     * @param w   Logical canvas width (CSS pixels)
     * @param h   Logical canvas height -- default floor Y when config.floorY is null
     */
    updateAndDraw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number): void;

    /** Kill all particles immediately. */
    clear(): void;

    /** Release all typed arrays. Idempotent. */
    destroy(): void;
}

/**
 * A spark preset: the seven positional `burst` fields. `ember` additionally
 * carries `scaleTo`/`fadeOut` engine-config HINTS (pass them to the SparkEngine
 * constructor); `burstPreset` ignores them.
 */
export interface SparkPreset {
    count: number;
    angleMin: number;
    angleMax: number;
    speedMin: number;
    speedMax: number;
    lifeMin: number;
    lifeMax: number;
    /** Enveloped-lane hint (ember): line-width multiplier at end of life. */
    scaleTo?: number;
    /** Enveloped-lane hint (ember): alpha reduction at end of life. */
    fadeOut?: number;
}

/**
 * Frozen preset descriptors. `weld`/`grind`/`impact` are burst-only; `ember`
 * carries scaleTo/fadeOut hints for the enveloped render lane.
 */
export declare const SPARK_PRESETS: Readonly<{
    weld: Readonly<SparkPreset>;
    grind: Readonly<SparkPreset>;
    impact: Readonly<SparkPreset>;
    ember: Readonly<SparkPreset>;
}>;

/**
 * Positional preset adapter: reads a preset's fields and calls engine.burst with
 * them, allocating nothing (no spread, no temp object). A null preset is a no-op.
 */
export declare function burstPreset(
    engine: SparkEngine, x: number, y: number, preset: SparkPreset | null | undefined
): void;

/** A fractional-carry emitter descriptor produced by `makeEmitter`. */
export interface Emitter {
    x: number;
    y: number;
    rate: number;
    cone: number;
    speed: number;
    life: number;
    /** Fractional spark credit carried across steps. */
    carry: number;
    /** Accumulate rate*dt, spawn the integer part, keep the remainder. Zero-alloc. */
    step(engine: SparkEngine, dt: number): void;
}

/**
 * Build a fractional-rate emitter. Non-finite/negative rate/speed/life -> 0 (an
 * inert emitter); non-finite x/y/cone -> 0. The cone is a half-spread in radians
 * around straight up (-TAU/4).
 */
export declare function makeEmitter(opts: {
    x?: number; y?: number; rate?: number; cone?: number; speed?: number; life?: number;
}): Emitter;
