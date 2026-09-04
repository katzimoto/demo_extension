'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeConfig } = require('../src/lib/config.js');

test('a well-formed config passes through', () => {
  assert.deepEqual(
    normalizeConfig({ enabled: true, collectUrl: true, minIntervalMs: 5000 }),
    { enabled: true, collectUrl: true, minIntervalMs: 5000 }
  );
});

test('FAILS CLOSED: missing fields collapse to the narrower value', () => {
  assert.deepEqual(normalizeConfig({}), {
    enabled: false, collectUrl: false, minIntervalMs: 0,
  });
});

test('FAILS CLOSED: non-object input collapses to the narrower value', () => {
  const closed = { enabled: false, collectUrl: false, minIntervalMs: 0 };
  for (const raw of [null, undefined, 'yes', 42, [], true]) {
    assert.deepEqual(normalizeConfig(raw), closed, `input ${JSON.stringify(raw)}`);
  }
});

test('FAILS CLOSED: truthy-but-not-true values do not enable', () => {
  for (const truthy of ['true', 1, 'yes', {}, []]) {
    const config = normalizeConfig({ enabled: truthy, collectUrl: truthy });
    assert.equal(config.enabled, false, `enabled from ${JSON.stringify(truthy)}`);
    assert.equal(config.collectUrl, false, `collectUrl from ${JSON.stringify(truthy)}`);
  }
});

test('a negative or fractional interval collapses to 0', () => {
  assert.equal(normalizeConfig({ minIntervalMs: -1 }).minIntervalMs, 0);
  assert.equal(normalizeConfig({ minIntervalMs: 1.5 }).minIntervalMs, 0);
  assert.equal(normalizeConfig({ minIntervalMs: 'soon' }).minIntervalMs, 0);
  assert.equal(normalizeConfig({ minIntervalMs: NaN }).minIntervalMs, 0);
  assert.equal(normalizeConfig({ minIntervalMs: Infinity }).minIntervalMs, 0);
});

test('zero is a legitimate interval and is preserved', () => {
  assert.equal(normalizeConfig({ minIntervalMs: 0 }).minIntervalMs, 0);
});

test('unknown keys are dropped, not carried through', () => {
  const config = normalizeConfig({ enabled: true, collectValues: true, endpoint: 'evil' });
  assert.deepEqual(Object.keys(config).sort(), ['collectUrl', 'enabled', 'minIntervalMs']);
});

test('collectUrl is independent of enabled', () => {
  const config = normalizeConfig({ enabled: true, collectUrl: false });
  assert.equal(config.enabled, true);
  assert.equal(config.collectUrl, false);
});
