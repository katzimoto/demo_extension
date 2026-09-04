'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { buildPayload } = require('../src/lib/payload.js');
const { normalizeConfig } = require('../src/lib/config.js');
const { extractForms } = require('../src/lib/form-extractor.js');

const FORMS = [{ index: 0, id: 'f', name: '', action: '/x', method: 'get', fieldCount: 0, fields: [] }];

test('includes url when includeUrl is true', () => {
  const payload = buildPayload(FORMS, 'https://example.com/a', 123, {
    enabled: true, includeUrl: true, minIntervalMs: 0,
  });
  assert.equal(payload.url, 'https://example.com/a');
  assert.equal(payload.sentAt, 123);
  assert.deepEqual(payload.forms, FORMS);
});

test('omits url entirely when includeUrl is false', () => {
  const payload = buildPayload(FORMS, 'https://example.com/a', 123, {
    enabled: true, includeUrl: false, minIntervalMs: 0,
  });
  assert.ok(!('url' in payload), 'url key must be absent, not undefined');
  assert.deepEqual(Object.keys(payload).sort(), ['forms', 'sentAt']);
});

test('a missing or malformed config omits the url', () => {
  for (const config of [undefined, null, {}, { includeUrl: 'true' }]) {
    const payload = buildPayload(FORMS, 'https://example.com/a', 1, config);
    assert.ok(!('url' in payload), `config ${JSON.stringify(config)}`);
  }
});

test('FIXED SHAPE: no config value can add a key', () => {
  const hostile = normalizeConfig({
    enabled: true, includeUrl: true, minIntervalMs: 0,
    collectValues: true, includeCookies: true, extraFields: ['password'],
  });
  const payload = buildPayload(FORMS, 'https://example.com/a', 1, hostile);
  assert.deepEqual(Object.keys(payload).sort(), ['forms', 'sentAt', 'url']);
});

test('FIXED SHAPE: raw unnormalised config cannot add a key either', () => {
  const payload = buildPayload(FORMS, 'https://example.com/a', 1, {
    includeUrl: true, collectValues: true, secrets: 'yes',
  });
  assert.deepEqual(Object.keys(payload).sort(), ['forms', 'sentAt', 'url']);
});

test('CROSS-MODULE GUARD: typed input never reaches the payload', () => {
  const dom = new JSDOM(`
    <form action="/login" method="post">
      <label for="e">Email</label><input type="email" name="email" id="e">
      <input type="password" name="pw">
      <textarea name="note"></textarea>
    </form>
  `);
  const doc = dom.window.document;
  doc.querySelector('input[type=email]').value = 'victim@example.com';
  doc.querySelector('input[type=password]').value = 'hunter2';
  doc.querySelector('textarea').value = 'private note';

  const { forms } = extractForms(doc);
  const payload = buildPayload(forms, 'https://example.com/login', 1, {
    enabled: true, includeUrl: true, minIntervalMs: 0,
  });

  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes('victim@example.com'));
  assert.ok(!wire.includes('hunter2'));
  assert.ok(!wire.includes('private note'));
  for (const field of payload.forms[0].fields) {
    assert.ok(!('value' in field), `${field.name} must carry no value key`);
  }
});

test('forms are passed through by reference without mutation', () => {
  const original = JSON.parse(JSON.stringify(FORMS));
  buildPayload(FORMS, 'https://example.com/a', 1, { includeUrl: true });
  assert.deepEqual(FORMS, original);
});
