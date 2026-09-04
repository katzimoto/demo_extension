'use strict';

// Fail-closed default for a malformed or absent interval. NOT zero: zero means
// "no throttling", which is the least restrictive value this field can take, so
// collapsing to it would let a garbled config produce MORE collection than a
// well-formed one — the opposite of the invariant this module exists to hold.
const DEFAULT_MIN_INTERVAL_MS = 60000;

// Every branch fails closed: anything missing, malformed, or of the wrong type
// collapses to the NARROWER value. A garbled config must never produce more
// collection than a well-formed one.
function normalizeConfig(raw) {
  const source =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const interval = source.minIntervalMs;

  return {
    enabled: source.enabled === true,
    includeUrl: source.includeUrl === true,
    minIntervalMs:
      Number.isInteger(interval) && interval >= 0
        ? interval
        : DEFAULT_MIN_INTERVAL_MS,
  };
}

// Whether a send made `previous` ms ago should be throttled at time `now`,
// given a `minIntervalMs` window. Guards against a backwards clock: if
// `previous` is somehow in the future (clock skew, storage from a future
// session), `now - previous` goes negative and must not be treated as "still
// inside the window" — that would wedge the throttle with a countdown that
// never clears.
function shouldThrottle(now, previous, minIntervalMs) {
  if (minIntervalMs <= 0) return false;
  if (!Number.isFinite(previous) || previous <= 0) return false;
  const elapsed = now - previous;
  if (elapsed < 0) return false; // clock moved backwards; do not wedge
  return elapsed < minIntervalMs;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeConfig, DEFAULT_MIN_INTERVAL_MS, shouldThrottle };
}
