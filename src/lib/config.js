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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeConfig, DEFAULT_MIN_INTERVAL_MS };
}
