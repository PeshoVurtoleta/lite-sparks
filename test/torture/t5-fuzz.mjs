/**
 * T5 -- differential fuzz against an invariant oracle.
 *
 * Registered but EMPTY in S0. S3 fills it: 100k mixed ops (random valid/hostile
 * burst args, random valid dt, random live config mutation) checked after every
 * op against the invariant set (`aliveFinite`, `aliveCount <= max`, every
 * `state[i]` in {0,1}). It waits on S1's hostile-input doors so the oracle has a
 * defined answer to fuzz against.
 */

export function run() {
    // Intentionally empty in S0 -- S3 wires the fuzz loop.
}
