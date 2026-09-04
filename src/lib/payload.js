'use strict';

// The payload shape is fixed HERE, in client code, and nowhere else. There is
// no path from a config value to a new key, which is what makes a configurable
// endpoint safe: pointing the extension at a hostile server yields a server
// that can turn collection off, not one that can widen it.
function buildPayload(forms, url, now, config) {
  const payload = { sentAt: now, forms };
  if (config && config.collectUrl === true) {
    payload.url = url;
  }
  return payload;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPayload };
}
