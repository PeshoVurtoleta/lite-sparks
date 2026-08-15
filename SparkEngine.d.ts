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
     * @param x         Origin X
     * @param y         Origin Y
     * @param count     Number of sparks to spawn (< 1, NaN, or Infinity spawn 0; floored to an integer)
     * @param angleMin  Emission cone start (radians)
     * @param angleMax  Emission cone end (radians)
     * @param speedMin  Minimum launch speed (px/s)
     * @param speedMax  Maximum launch speed (px/s)
     * @param lifeMin   Minimum lifetime (seconds). Default: 0.5
     * @param lifeMax   Maximum lifetime (seconds). Default: 1.5
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
