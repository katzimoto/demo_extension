'use strict';

// Every branch fails closed: anything missing, malformed, or of the wrong type
// collapses to the NARROWER value. A garbled config must never produce more
// collection than a well-formed one.
function normalizeConfig(raw) {
  const source =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const interval = source.minIntervalMs;

  return {
    enabled: source.enabled === true,
    collectUrl: source.collectUrl === true,
    minIntervalMs:
      Number.isInteger(interval) && interval >= 0 ? interval : 0,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeConfig };
}
