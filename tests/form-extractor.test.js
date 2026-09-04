'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { extractForms, formControls } = require('../src/lib/form-extractor.js');

function docFrom(html) {
  return new JSDOM(html).window.document;
}

test('returns one descriptor per form, in document order', () => {
  const doc = docFrom('<form id="a"></form><form id="b"></form>');
  const { forms } = extractForms(doc);
  assert.equal(forms.length, 2);
  assert.deepEqual(forms.map((f) => f.id), ['a', 'b']);
  assert.deepEqual(forms.map((f) => f.index), [0, 1]);
});

test('a page with no forms yields an empty list', () => {
  const { forms } = extractForms(docFrom('<p>nothing here</p>'));
  assert.deepEqual(forms, []);
});

test('method defaults to get and is lowercased', () => {
  const doc = docFrom('<form></form><form method="POST"></form>');
  const { forms } = extractForms(doc);
  assert.equal(forms[0].method, 'get');
  assert.equal(forms[1].method, 'post');
});

test('action is the authored attribute, not a resolved URL', () => {
  const doc = docFrom('<form action="/session"></form>');
  assert.equal(extractForms(doc).forms[0].action, '/session');
});

test('missing id, name and action become empty strings', () => {
  const form = extractForms(docFrom('<form></form>')).forms[0];
  assert.equal(form.id, '');
  assert.equal(form.name, '');
  assert.equal(form.action, '');
});

test('enumerates fields with tag, type, name, id and flags', () => {
  const doc = docFrom(`
    <form>
      <input type="EMAIL" name="email" id="e" required>
      <input type="text" name="nick" disabled>
    </form>
  `);
  const { fields, fieldCount } = extractForms(doc).forms[0];
  assert.equal(fieldCount, 2);
  assert.deepEqual(fields[0], {
    index: 0, tag: 'input', type: 'email', name: 'email', id: 'e',
    label: null, labelSource: 'none', required: true, disabled: false,
  });
  assert.equal(fields[1].type, 'text');
  assert.equal(fields[1].name, 'nick');
  assert.equal(fields[1].id, '');
  assert.equal(fields[1].disabled, true);
  assert.equal(fields[1].required, false);
});

test('input with no type attribute defaults to text', () => {
  const doc = docFrom('<form><input name="q"></form>');
  assert.equal(extractForms(doc).forms[0].fields[0].type, 'text');
});

test('a field with no name attribute reports an empty string', () => {
  const f = extractForms(docFrom('<form><input type="text" id="only-id"></form>')).forms[0].fields[0];
  assert.equal(f.name, '');
  assert.equal(f.id, 'only-id');
});

test('fieldset is not counted as a field', () => {
  const doc = docFrom('<form><fieldset><input name="a"></fieldset></form>');
  const { fields } = extractForms(doc).forms[0];
  assert.equal(fields.length, 1);
  assert.equal(fields[0].tag, 'input');
});

test('formControls returns elements aligned with the fields array', () => {
  const doc = docFrom('<form><input name="a"><textarea name="b"></textarea></form>');
  const form = doc.forms[0];
  const controls = formControls(form);
  const { fields } = extractForms(doc).forms[0];
  assert.equal(controls.length, fields.length);
  assert.equal(controls[0].getAttribute('name'), fields[0].name);
  assert.equal(controls[1].getAttribute('name'), fields[1].name);
});

test('fields associated by the form attribute are included', () => {
  const doc = docFrom('<form id="f"></form><input name="outside" form="f">');
  const { fields } = extractForms(doc).forms[0];
  assert.equal(fields.length, 1);
  assert.equal(fields[0].name, 'outside');
});
