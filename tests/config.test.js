'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeConfig, DEFAULT_MIN_INTERVAL_MS } = require('../src/lib/config.js');

test('a well-formed config passes through', () => {
  assert.deepEqual(
    normalizeConfig({ enabled: true, includeUrl: true, minIntervalMs: 5000 }),
    { enabled: true, includeUrl: true, minIntervalMs: 5000 }
  );
});

test('FAILS CLOSED: missing fields collapse to the narrower value', () => {
  assert.deepEqual(normalizeConfig({}), {
    enabled: false, includeUrl: false, minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  });
});

test('FAILS CLOSED: non-object input collapses to the narrower value', () => {
  const closed = { enabled: false, includeUrl: false, minIntervalMs: DEFAULT_MIN_INTERVAL_MS };
  for (const raw of [null, undefined, 'yes', 42, [], true]) {
    assert.deepEqual(normalizeConfig(raw), closed, `input ${JSON.stringify(raw)}`);
  }
});

test('FAILS CLOSED: truthy-but-not-true values do not enable', () => {
  for (const truthy of ['true', 1, 'yes', {}, []]) {
    const config = normalizeConfig({ enabled: truthy, includeUrl: truthy });
    assert.equal(config.enabled, false, `enabled from ${JSON.stringify(truthy)}`);
    assert.equal(config.includeUrl, false, `includeUrl from ${JSON.stringify(truthy)}`);
  }
});

test('a negative or fractional interval collapses to the conservative default', () => {
  assert.equal(normalizeConfig({ minIntervalMs: -1 }).minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ minIntervalMs: 1.5 }).minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ minIntervalMs: 'soon' }).minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ minIntervalMs: NaN }).minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ minIntervalMs: Infinity }).minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
});

test('zero is a legitimate interval and is preserved', () => {
  assert.equal(normalizeConfig({ minIntervalMs: 0 }).minIntervalMs, 0);
});

test('unknown keys are dropped, not carried through', () => {
  const config = normalizeConfig({ enabled: true, collectValues: true, endpoint: 'evil' });
  assert.deepEqual(Object.keys(config).sort(), ['enabled', 'includeUrl', 'minIntervalMs']);
});

test('includeUrl is independent of enabled', () => {
  const config = normalizeConfig({ enabled: true, includeUrl: false });
  assert.equal(config.enabled, true);
  assert.equal(config.includeUrl, false);
});

test('FAILS CLOSED: a corrupted interval throttles rather than unthrottles', () => {
  const wellFormed = normalizeConfig({ enabled: true, minIntervalMs: 5000 });
  for (const bad of [null, undefined, '5000', -1, 1.5, NaN, Infinity, {}]) {
    const garbled = normalizeConfig({ enabled: true, minIntervalMs: bad });
    assert.ok(
      garbled.minIntervalMs >= wellFormed.minIntervalMs,
      `a garbled interval (${String(bad)}) must not collect more often than a well-formed one`
    );
  }
});
