# Form Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 Chrome extension whose popup lists the forms on the current page with a hover-to-highlight field inventory, alongside that URL's visit history.

**Architecture:** No declared content script and no background service worker. The popup is the sole orchestrator: on open it injects `lib/form-extractor.js` + `content/inspector.js` into the active tab via `chrome.scripting.executeScript` under `activeTab`, then messages the injected inspector to scan. All real logic lives in `form-extractor.js`, a pure `Document -> descriptors` function with no `chrome.*` dependency, which is the only unit-tested part.

**Tech Stack:** Vanilla JavaScript, no build step. Chrome MV3 APIs (`scripting`, `tabs`, `history`, `runtime`). `node --test` + jsdom for unit tests.

**Spec:** `docs/superpowers/specs/2026-09-04-form-inspector-extension-design.md`

## Global Constraints

- Manifest V3. `"permissions": ["activeTab", "scripting", "history"]` — exactly these three.
- **No `host_permissions` key. No `<all_urls>`. No `content_scripts` key. No `background` key.** All four are deliberate; adding any of them contradicts the design.
- The extension root is `src/`. Chrome loads **`src/`** as the unpacked extension, so paths inside `manifest.json` and `executeScript` are relative to `src/`.
- No build step. Every file Chrome loads is authored JavaScript, shipped as-is.
- `package.json` MUST omit the `"type"` field, so test files are CommonJS and can `require` the same `form-extractor.js` the browser loads.
- `jsdom` is the only dependency, and it is a devDependency.
- **Value policy:** a field descriptor carries a `value` key only when its type is `radio` or `checkbox`, and only from `getAttribute('value')` — the authored attribute, never the live `.value` property. Every other type has no `value` key at all. This is the mechanical guarantee that typed input is never surfaced.
- Label resolution follows HTML-AAM order: `aria-labelledby` > `aria-label` > `<label for>` > wrapping `<label>` > `placeholder` > none.
- Keep files under 500 lines.
- Commit messages: no `Co-Authored-By` trailer.

---

### Task 1: Extractor — form and field enumeration

Establishes the project scaffold and the core `extractForms` shape. Scaffold is folded in here because this is the first task that needs it.

**Files:**
- Create: `package.json`
- Create: `src/lib/form-extractor.js`
- Test: `tests/form-extractor.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `extractForms(doc: Document) -> { forms: FormDescriptor[] }`
  - `formControls(form: HTMLFormElement) -> Element[]` — the filtered control list; Task 5's inspector uses this to cache element references in an order guaranteed to match `fields[]` indices.
  - `FormDescriptor`: `{ index, id, name, action, method, fieldCount, fields }`
  - `FieldDescriptor`: `{ index, tag, type, name, id, label, labelSource, required, disabled }` (+ optional `value`, added in Task 3)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "form-inspector",
  "version": "0.1.0",
  "private": true,
  "description": "Chrome extension that inspects page forms and URL visit history",
  "scripts": {
    "test": "node --test"
  },
  "devDependencies": {
    "jsdom": "^24.1.0"
  }
}
```

Note the deliberate absence of `"type"`. Then run `npm install`.

- [ ] **Step 2: Write the failing test**

Create `tests/form-extractor.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/form-extractor.js'`

- [ ] **Step 4: Write the minimal implementation**

Create `src/lib/form-extractor.js`:

```js
'use strict';

const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);

function formControls(form) {
  return Array.from(form.elements).filter(
    (el) => CONTROL_TAGS.has(el.tagName.toLowerCase())
  );
}

function fieldType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') return el.multiple ? 'select-multiple' : 'select-one';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'button') return (el.getAttribute('type') || 'submit').toLowerCase();
  return (el.getAttribute('type') || 'text').toLowerCase();
}

function describeField(el, index) {
  return {
    index,
    tag: el.tagName.toLowerCase(),
    type: fieldType(el),
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    label: null,
    labelSource: 'none',
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
  };
}

function describeForm(form, index) {
  const fields = formControls(form).map((el, i) => describeField(el, i));
  return {
    index,
    id: form.getAttribute('id') || '',
    name: form.getAttribute('name') || '',
    action: form.getAttribute('action') || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fieldCount: fields.length,
    fields,
  };
}

function extractForms(doc) {
  return { forms: Array.from(doc.forms).map(describeForm) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractForms, formControls };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/form-extractor.js tests/form-extractor.test.js
git commit -m "Add form extractor with form and field enumeration"
```

---

### Task 2: Extractor — label resolution

**Files:**
- Modify: `src/lib/form-extractor.js` (add `resolveLabel`, call it from `describeField`)
- Test: `tests/form-extractor.test.js` (append)

**Interfaces:**
- Consumes: `extractForms`, `describeField` from Task 1
- Produces: `label: string | null` and `labelSource: 'aria-labelledby' | 'aria-label' | 'for' | 'wrap' | 'placeholder' | 'none'` on every FieldDescriptor

- [ ] **Step 1: Write the failing tests**

Append to `tests/form-extractor.test.js`:

```js
function firstField(html) {
  return extractForms(docFrom(html)).forms[0].fields[0];
}

test('label resolves from label[for]', () => {
  const f = firstField('<form><label for="e">Email address</label><input id="e"></form>');
  assert.equal(f.label, 'Email address');
  assert.equal(f.labelSource, 'for');
});

test('label resolves from a wrapping label', () => {
  const f = firstField('<form><label>Full name <input name="n"></label></form>');
  assert.equal(f.label, 'Full name');
  assert.equal(f.labelSource, 'wrap');
});

test('a wrapping label excludes text of nested controls', () => {
  const f = firstField(
    '<form><label>Country <select name="c"><option>Norway</option></select></label></form>'
  );
  assert.equal(f.label, 'Country');
  assert.equal(f.labelSource, 'wrap');
});

test('aria-label outranks a wrapping label', () => {
  const f = firstField('<form><label>Visible <input aria-label="Announced"></label></form>');
  assert.equal(f.label, 'Announced');
  assert.equal(f.labelSource, 'aria-label');
});

test('aria-labelledby outranks a present label[for]', () => {
  const f = firstField(`
    <form>
      <span id="t">From ARIA</span>
      <label for="e">From label</label>
      <input id="e" aria-labelledby="t">
    </form>
  `);
  assert.equal(f.label, 'From ARIA');
  assert.equal(f.labelSource, 'aria-labelledby');
});

test('aria-labelledby joins multiple referenced elements in order', () => {
  const f = firstField(`
    <form>
      <span id="a">Billing</span><span id="b">address</span>
      <input aria-labelledby="a b">
    </form>
  `);
  assert.equal(f.label, 'Billing address');
});

test('aria-labelledby pointing at a missing id falls through', () => {
  const f = firstField('<form><input aria-labelledby="nope" placeholder="Search"></form>');
  assert.equal(f.label, 'Search');
  assert.equal(f.labelSource, 'placeholder');
});

test('placeholder is the last resort before none', () => {
  const f = firstField('<form><input placeholder="Search here"></form>');
  assert.equal(f.label, 'Search here');
  assert.equal(f.labelSource, 'placeholder');
});

test('a field with nothing to label it reports none', () => {
  const f = firstField('<form><input name="bare"></form>');
  assert.equal(f.label, null);
  assert.equal(f.labelSource, 'none');
});

test('label text is whitespace-collapsed', () => {
  const f = firstField('<form><label for="e">  Email\n   address </label><input id="e"></form>');
  assert.equal(f.label, 'Email address');
});

test('an empty label element falls through to the next source', () => {
  const f = firstField('<form><label for="e"></label><input id="e" placeholder="Fallback"></form>');
  assert.equal(f.label, 'Fallback');
  assert.equal(f.labelSource, 'placeholder');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — labels come back `null` with `labelSource: 'none'`.

- [ ] **Step 3: Implement label resolution**

In `src/lib/form-extractor.js`, add above `describeField`:

```js
function collapseWs(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function textOf(el) {
  return el ? collapseWs(el.textContent) : '';
}

function wrappingLabelText(label) {
  const clone = label.cloneNode(true);
  clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
  return textOf(clone);
}

function labelForId(doc, id) {
  if (!id) return null;
  for (const label of doc.querySelectorAll('label[for]')) {
    if (label.getAttribute('for') === id) return label;
  }
  return null;
}

function resolveLabel(el, doc) {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(doc.getElementById(id)))
      .filter(Boolean)
      .join(' ');
    if (text) return { label: text, labelSource: 'aria-labelledby' };
  }

  const ariaLabel = collapseWs(el.getAttribute('aria-label') || '');
  if (ariaLabel) return { label: ariaLabel, labelSource: 'aria-label' };

  const forLabel = labelForId(doc, el.getAttribute('id'));
  if (forLabel) {
    const text = textOf(forLabel);
    if (text) return { label: text, labelSource: 'for' };
  }

  const wrapping = el.closest('label');
  if (wrapping) {
    const text = wrappingLabelText(wrapping);
    if (text) return { label: text, labelSource: 'wrap' };
  }

  const placeholder = collapseWs(el.getAttribute('placeholder') || '');
  if (placeholder) return { label: placeholder, labelSource: 'placeholder' };

  return { label: null, labelSource: 'none' };
}
```

`labelForId` walks `label[for]` and compares attributes rather than building a
`label[for="..."]` selector, because ids can contain characters that need CSS
escaping and `CSS.escape` is not dependable under jsdom.

Then change `describeField` to take `doc` and use the resolution:

```js
function describeField(el, index, doc) {
  const { label, labelSource } = resolveLabel(el, doc);
  return {
    index,
    tag: el.tagName.toLowerCase(),
    type: fieldType(el),
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    label,
    labelSource,
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
  };
}
```

And thread `doc` through `describeForm`:

```js
function describeForm(form, index, doc) {
  const fields = formControls(form).map((el, i) => describeField(el, i, doc));
  return {
    index,
    id: form.getAttribute('id') || '',
    name: form.getAttribute('name') || '',
    action: form.getAttribute('action') || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fieldCount: fields.length,
    fields,
  };
}

function extractForms(doc) {
  return { forms: Array.from(doc.forms).map((form, i) => describeForm(form, i, doc)) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 25 tests (11 from Task 1, 14 label-resolution tests including whitespace collapse on every branch).

- [ ] **Step 5: Commit**

```bash
git add src/lib/form-extractor.js tests/form-extractor.test.js
git commit -m "Resolve field labels using HTML-AAM precedence"
```

---

### Task 3: Extractor — field-type coverage and the value policy

**Files:**
- Modify: `src/lib/form-extractor.js` (add the `value` key for radio/checkbox)
- Test: `tests/form-extractor.test.js` (append)

**Interfaces:**
- Consumes: `extractForms` from Tasks 1–2
- Produces: optional `value: string` on FieldDescriptor, present only for `radio` and `checkbox`

- [ ] **Step 1: Write the failing tests**

Append to `tests/form-extractor.test.js`:

```js
test('select reports select-one or select-multiple', () => {
  const doc = docFrom(`
    <form>
      <select name="one"><option>a</option></select>
      <select name="many" multiple><option>a</option></select>
    </form>
  `);
  const { fields } = extractForms(doc).forms[0];
  assert.equal(fields[0].type, 'select-one');
  assert.equal(fields[1].type, 'select-multiple');
  assert.equal(fields[0].tag, 'select');
});

test('textarea reports tag and type textarea', () => {
  const f = firstField('<form><textarea name="bio"></textarea></form>');
  assert.equal(f.tag, 'textarea');
  assert.equal(f.type, 'textarea');
});

test('button type defaults to submit', () => {
  const doc = docFrom('<form><button>Go</button><button type="RESET">Clear</button></form>');
  const { fields } = extractForms(doc).forms[0];
  assert.equal(fields[0].type, 'submit');
  assert.equal(fields[1].type, 'reset');
  assert.equal(fields[0].tag, 'button');
});

test('a radio group shares a name and is distinguished by value', () => {
  const doc = docFrom(`
    <form>
      <label>Yes <input type="radio" name="ok" value="y"></label>
      <label>No <input type="radio" name="ok" value="n"></label>
    </form>
  `);
  const { fields } = extractForms(doc).forms[0];
  assert.equal(fields.length, 2);
  assert.deepEqual(fields.map((f) => f.name), ['ok', 'ok']);
  assert.deepEqual(fields.map((f) => f.value), ['y', 'n']);
  assert.deepEqual(fields.map((f) => f.label), ['Yes', 'No']);
});

test('checkbox exposes its authored value', () => {
  const f = firstField('<form><input type="checkbox" name="tos" value="accepted"></form>');
  assert.equal(f.value, 'accepted');
});

test('a radio with no value attribute reports an empty string', () => {
  const f = firstField('<form><input type="radio" name="r"></form>');
  assert.equal(f.value, '');
});

test('text inputs carry no value key at all', () => {
  const f = firstField('<form><input type="text" name="q" value="preset"></form>');
  assert.ok(!('value' in f));
});

test('hidden inputs are listed but expose no value', () => {
  const f = firstField('<form><input type="hidden" name="csrf" value="s3cr3t"></form>');
  assert.equal(f.type, 'hidden');
  assert.equal(f.name, 'csrf');
  assert.ok(!('value' in f));
});

test('REGRESSION GUARD: typed input is never exposed', () => {
  const dom = new JSDOM('<form><input type="text" name="q"><textarea name="b"></textarea></form>');
  const doc = dom.window.document;
  doc.querySelector('input').value = 'typed secret';
  doc.querySelector('textarea').value = 'typed secret';
  const { fields } = extractForms(doc).forms[0];
  for (const field of fields) {
    assert.ok(!('value' in field), `${field.name} must not carry a value key`);
  }
  assert.ok(!JSON.stringify(fields).includes('typed secret'));
});

test('REGRESSION GUARD: checking a radio changes neither its reported value nor exposes checked state', () => {
  const dom = new JSDOM('<form><input type="radio" name="r" value="authored"></form>');
  const doc = dom.window.document;
  const radio = doc.querySelector('input');
  radio.checked = true;
  const f = extractForms(doc).forms[0].fields[0];
  assert.equal(f.value, 'authored');
  assert.ok(!('checked' in f));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the radio/checkbox tests fail because no `value` key is produced yet. The type tests for select/textarea/button should already pass from Task 1's `fieldType`; that is expected and fine.

- [ ] **Step 3: Implement the value policy**

In `src/lib/form-extractor.js`, add near `CONTROL_TAGS`:

```js
const VALUE_TYPES = new Set(['radio', 'checkbox']);
```

Then in `describeField`, build the descriptor and conditionally attach `value`:

```js
function describeField(el, index, doc) {
  const { label, labelSource } = resolveLabel(el, doc);
  const type = fieldType(el);
  const field = {
    index,
    tag: el.tagName.toLowerCase(),
    type,
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    label,
    labelSource,
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
  };
  if (VALUE_TYPES.has(type)) {
    field.value = el.getAttribute('value') || '';
  }
  return field;
}
```

`getAttribute('value')` is what keeps the guarantee for text-like inputs: their
`value` IDL attribute is in "value" mode, so assigning `.value` never touches the
content attribute and typed text cannot leak through. Radio and checkbox are in
"default/on" mode — their `.value` reflects the attribute — but that is page
script, not user input, and `checked` is never exposed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 35 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/form-extractor.js tests/form-extractor.test.js
git commit -m "Cover all control types and restrict value to radio and checkbox"
```

---

### Task 4: Extension shell — manifest and popup that identifies the tab

First browser-verified task. Deliverable: a loadable extension whose popup opens and names the current page. No form logic yet.

**Files:**
- Create: `src/manifest.json`
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.css`
- Create: `src/popup/popup.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: DOM contract used by Tasks 5–7 — elements with ids `page-url`, `forms`, `visits`; and `getActiveTab() -> Promise<chrome.tabs.Tab>`

- [ ] **Step 1: Write the manifest**

Create `src/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Form Inspector",
  "version": "0.1.0",
  "description": "Inspect the forms on the current page alongside your visit history for it.",
  "permissions": ["activeTab", "scripting", "history"],
  "action": {
    "default_title": "Form Inspector",
    "default_popup": "popup/popup.html"
  }
}
```

No `host_permissions`, no `content_scripts`, no `background`. Chrome supplies a
default toolbar icon when `action` declares none, which is fine for a demo.

- [ ] **Step 2: Write the popup markup**

Create `src/popup/popup.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <header>
      <h1>Form Inspector</h1>
      <p id="page-url" class="url">Reading tab&hellip;</p>
    </header>

    <section>
      <h2>Forms</h2>
      <div id="forms" class="panel">Scanning&hellip;</div>
    </section>

    <section>
      <h2>Visits</h2>
      <div id="visits" class="panel">Loading&hellip;</div>
    </section>

    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the popup styles**

Create `src/popup/popup.css`:

```css
:root {
  --bg: #ffffff;
  --fg: #1b1b1b;
  --muted: #666;
  --line: #e3e3e3;
  --accent: #b8860b;
  --hit: #fff6dd;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e1e;
    --fg: #eaeaea;
    --muted: #9a9a9a;
    --line: #3a3a3a;
    --accent: #e0a92a;
    --hit: #3a3320;
  }
}

* { box-sizing: border-box; }

body {
  width: 420px;
  max-height: 580px;
  overflow-y: auto;
  margin: 0;
  padding: 12px;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.45 system-ui, -apple-system, sans-serif;
}

h1 { font-size: 14px; margin: 0 0 2px; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 16px 0 6px; }

.url {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 11px;
  word-break: break-all;
}

.panel { border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.empty { color: var(--muted); font-style: italic; }
.error { color: var(--accent); }

.form-block { border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 8px; }
.form-block:last-child { border-bottom: 0; padding-bottom: 0; margin-bottom: 0; }
.form-head { font-weight: 600; }
.form-meta { color: var(--muted); font-size: 11px; word-break: break-all; }

ul.fields { list-style: none; margin: 6px 0 0; padding: 0; }
ul.fields li { padding: 3px 5px; border-radius: 4px; cursor: default; display: flex; gap: 6px; }
ul.fields li:hover { background: var(--hit); }
.f-label { flex: 1; }
.f-type { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }
.f-req { color: var(--accent); }
.unlabelled { color: var(--muted); font-style: italic; }

ul.visits { list-style: none; margin: 0; padding: 0; }
ul.visits li { display: flex; gap: 8px; padding: 2px 0; }
.v-when { font-variant-numeric: tabular-nums; }
.v-trans { color: var(--muted); font-size: 11px; }
.v-submit { color: var(--accent); font-weight: 600; }
.summary { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
```

- [ ] **Step 4: Write the popup bootstrap**

Create `src/popup/popup.js`:

```js
'use strict';

const urlEl = document.getElementById('page-url');
const formsEl = document.getElementById('forms');
const visitsEl = document.getElementById('visits');

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function main() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    urlEl.textContent = 'No active tab.';
    return;
  }
  urlEl.textContent = tab.url;
}

main();
```

- [ ] **Step 5: Load and verify in Chrome**

1. Open `chrome://extensions`, enable Developer mode.
2. "Load unpacked" and select the **`src/`** directory — not the repository root.
3. Open any page, click the Form Inspector icon.

Expected: the popup opens and shows the current page's full URL under the title. The Forms and Visits panels still read "Scanning…" and "Loading…". No errors in the popup's console (right-click the popup → Inspect).

- [ ] **Step 6: Commit**

```bash
git add src/manifest.json src/popup/
git commit -m "Add MV3 manifest and popup shell showing the active tab URL"
```

---

### Task 5: Inspector injection and form rendering

**Files:**
- Create: `src/content/inspector.js`
- Modify: `src/popup/popup.js`

**Interfaces:**
- Consumes: `extractForms`, `formControls` (Tasks 1–3); `getActiveTab`, DOM ids (Task 4)
- Produces:
  - Message `{type:'scan'}` → response `{ forms: FormDescriptor[] }`
  - `window.__formInspectorReady` — the re-injection guard flag
  - `renderForms(forms)` in `popup.js`, which Task 6 extends with hover handlers

- [ ] **Step 1: Write the inspector content script**

Create `src/content/inspector.js`:

```js
'use strict';

(() => {
  if (window.__formInspectorReady) return;
  window.__formInspectorReady = true;

  // cache[formIndex][fieldIndex] -> Element. Built with formControls() so the
  // indices line up with the descriptors by construction.
  let cache = [];

  function rebuildCache() {
    cache = Array.from(document.forms).map((form) => formControls(form));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'scan') {
      const result = extractForms(document);
      rebuildCache();
      sendResponse(result);
    }
    return false;
  });
})();
```

`extractForms` and `formControls` are top-level declarations in
`form-extractor.js`, which `executeScript` injects into the same isolated world
immediately before this file, so they are in scope here.

- [ ] **Step 2: Wire injection and rendering into the popup**

In `src/popup/popup.js`, add above `main`:

```js
const CANNOT_INJECT =
  'This page cannot be inspected. Chrome blocks extensions on browser pages ' +
  '(chrome://, the Web Store, and the PDF viewer).';

async function scanForms(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['lib/form-extractor.js', 'content/inspector.js'],
  });
  return chrome.tabs.sendMessage(tabId, { type: 'scan' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldRow(field) {
  const li = el('li');
  li.dataset.fieldIndex = String(field.index);

  const name = field.label || field.name || field.id;
  const label = el('span', field.label ? 'f-label' : 'f-label unlabelled',
    name || '(unnamed)');
  li.appendChild(label);

  if (field.required) li.appendChild(el('span', 'f-req', 'required'));
  li.appendChild(el('span', 'f-type', field.type));
  return li;
}

function formBlock(form) {
  const block = el('div', 'form-block');
  block.dataset.formIndex = String(form.index);

  const title = form.id || form.name || `form #${form.index + 1}`;
  block.appendChild(el('div', 'form-head',
    `${title} — ${form.fieldCount} field${form.fieldCount === 1 ? '' : 's'}`));
  block.appendChild(el('div', 'form-meta',
    `${form.method.toUpperCase()} ${form.action || '(no action)'}`));

  const list = el('ul', 'fields');
  form.fields.forEach((field) => list.appendChild(fieldRow(field)));
  block.appendChild(list);
  return block;
}

function renderForms(forms) {
  formsEl.replaceChildren();
  if (forms.length === 0) {
    formsEl.appendChild(el('p', 'empty', 'No forms on this page.'));
    return;
  }
  forms.forEach((form) => formsEl.appendChild(formBlock(form)));
}
```

Then replace `main` with:

```js
async function main() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    urlEl.textContent = 'No active tab.';
    return;
  }
  urlEl.textContent = tab.url;

  try {
    const { forms } = await scanForms(tab.id);
    renderForms(forms);
  } catch (err) {
    formsEl.replaceChildren(el('p', 'error', CANNOT_INJECT));
    console.debug('Form Inspector: injection failed', err);
  }
}
```

The `try` wraps only the forms half, so a blocked injection cannot prevent
Task 7's visits section from rendering.

- [ ] **Step 3: Verify in Chrome**

1. Reload the extension at `chrome://extensions`.
2. Visit a page with a real form — `https://developer.mozilla.org/en-US/search` or any login page.

Expected: each form appears with its method, action and field count, and every field is listed with its resolved label and type.

3. Open a page with no forms (`https://example.com`).

Expected: "No forms on this page."

4. Open `chrome://version`.

Expected: the explanatory "cannot be inspected" message, not an empty panel or a broken popup.

- [ ] **Step 4: Commit**

```bash
git add src/content/inspector.js src/popup/popup.js
git commit -m "Inject inspector on popup open and render the page's forms"
```

---

### Task 6: Hover-to-highlight

**Files:**
- Modify: `src/content/inspector.js` (overlay + highlight/clear messages)
- Modify: `src/popup/popup.js` (hover wiring)

**Interfaces:**
- Consumes: the cache and message listener from Task 5
- Produces: messages `{type:'highlight', formIndex, fieldIndex}` → `{ok: boolean}`, and `{type:'clearHighlight'}` → `{ok: true}`

- [ ] **Step 1: Add the overlay to the inspector**

In `src/content/inspector.js`, inside the IIFE above the listener:

```js
  let overlay = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'z-index:2147483647',
      'outline:2px solid #e0a92a',
      'background:rgba(224,169,42,0.18)',
      'border-radius:2px',
      'display:none',
    ].join(';');
    document.body.appendChild(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  function highlight(target) {
    const rect = target.getBoundingClientRect();
    // Hidden inputs and display:none controls have no box to draw.
    if (rect.width === 0 && rect.height === 0) {
      hideOverlay();
      return false;
    }
    const box = ensureOverlay();
    box.style.top = `${rect.top + window.scrollY}px`;
    box.style.left = `${rect.left + window.scrollX}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.display = 'block';
    return true;
  }
```

The overlay is a separate absolutely-positioned element: the target's own
styles are never mutated, so there is nothing to restore, and it works on
elements that already carry an `outline`.

- [ ] **Step 2: Handle the new messages**

Extend the listener in `src/content/inspector.js`:

```js
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'scan') {
      const result = extractForms(document);
      rebuildCache();
      sendResponse(result);
    } else if (msg.type === 'highlight') {
      const target = (cache[msg.formIndex] || [])[msg.fieldIndex];
      sendResponse({ ok: target ? highlight(target) : false });
    } else if (msg.type === 'clearHighlight') {
      hideOverlay();
      sendResponse({ ok: true });
    }
    return false;
  });
```

- [ ] **Step 3: Wire hover in the popup**

In `src/popup/popup.js`, add:

```js
function wireHighlighting(tabId) {
  const send = (message) => {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  };

  formsEl.addEventListener('mouseover', (event) => {
    const li = event.target.closest('li[data-field-index]');
    if (!li) return;
    const block = li.closest('[data-form-index]');
    send({
      type: 'highlight',
      formIndex: Number(block.dataset.formIndex),
      fieldIndex: Number(li.dataset.fieldIndex),
    });
  });

  formsEl.addEventListener('mouseout', (event) => {
    if (event.target.closest('li[data-field-index]')) send({ type: 'clearHighlight' });
  });

  window.addEventListener('pagehide', () => send({ type: 'clearHighlight' }));
}
```

`.catch(() => {})` is required: `sendMessage` rejects when the popup closes
mid-flight or the tab navigated away, and an unhandled rejection would surface
as a console error on every popup close.

Then call it in `main`, immediately after `renderForms(forms)`:

```js
    renderForms(forms);
    wireHighlighting(tab.id);
```

- [ ] **Step 4: Verify in Chrome**

1. Reload the extension, open a page with a form.
2. Hover each field row in the popup.

Expected: the matching element on the page gets an amber overlay, the overlay follows from field to field, it disappears on mouse-out, and it is gone from the page after the popup closes. Hovering a hidden input draws nothing rather than a zero-size artifact. Confirm on a page scrolled well down that the overlay lands on the element, not offset by the scroll position.

- [ ] **Step 5: Commit**

```bash
git add src/content/inspector.js src/popup/popup.js
git commit -m "Highlight the hovered field on the page with an overlay"
```

---

### Task 7: Visits section

**Files:**
- Modify: `src/popup/popup.js`

**Interfaces:**
- Consumes: `getActiveTab`, `el`, `visitsEl` (Tasks 4–5)
- Produces: `renderVisits(url)` — final task, nothing downstream consumes it

- [ ] **Step 1: Add history loading and rendering**

In `src/popup/popup.js`, add:

```js
const TRANSITION_LABELS = {
  link: 'link',
  typed: 'typed',
  auto_bookmark: 'bookmark',
  auto_subframe: 'subframe',
  manual_subframe: 'subframe',
  generated: 'generated',
  auto_toplevel: 'startup',
  form_submit: 'form submit',
  reload: 'reload',
  keyword: 'keyword',
  keyword_generated: 'keyword',
};

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function loadVisits(url) {
  const [visits, matches] = await Promise.all([
    chrome.history.getVisits({ url }),
    chrome.history.search({ text: url, startTime: 0, maxResults: 100 }),
  ]);
  // search() matches substrings across URL and title, so narrow to this URL.
  const item = matches.find((m) => m.url === url) || null;
  return { visits, item };
}

function visitRow(visit) {
  const li = el('li');
  li.appendChild(el('span', 'v-when', formatWhen(visit.visitTime)));
  const label = TRANSITION_LABELS[visit.transition] || visit.transition;
  const isSubmit = visit.transition === 'form_submit';
  li.appendChild(el('span', isSubmit ? 'v-trans v-submit' : 'v-trans', label));
  return li;
}

async function renderVisits(url) {
  let visits;
  let item;
  try {
    ({ visits, item } = await loadVisits(url));
  } catch (err) {
    visitsEl.replaceChildren(el('p', 'error', 'Could not read history.'));
    console.debug('Form Inspector: history read failed', err);
    return;
  }

  visitsEl.replaceChildren();

  if (visits.length === 0) {
    visitsEl.appendChild(el('p', 'empty', 'No recorded visits for this exact URL.'));
    return;
  }

  const sorted = [...visits].sort((a, b) => b.visitTime - a.visitTime);
  const total = item ? item.visitCount : visits.length;
  visitsEl.appendChild(el('p', 'summary',
    `${total} visit${total === 1 ? '' : 's'} · first ${formatWhen(sorted[sorted.length - 1].visitTime)} · last ${formatWhen(sorted[0].visitTime)}`));

  const list = el('ul', 'visits');
  sorted.slice(0, 20).forEach((visit) => list.appendChild(visitRow(visit)));
  visitsEl.appendChild(list);

  if (sorted.length > 20) {
    visitsEl.appendChild(el('p', 'summary', `Showing the 20 most recent of ${sorted.length}.`));
  }
}
```

- [ ] **Step 2: Call it concurrently with the form scan**

Rewrite `main` in `src/popup/popup.js` so neither section blocks the other:

```js
async function main() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    urlEl.textContent = 'No active tab.';
    return;
  }
  urlEl.textContent = tab.url;

  const forms = (async () => {
    try {
      const result = await scanForms(tab.id);
      renderForms(result.forms);
      wireHighlighting(tab.id);
    } catch (err) {
      formsEl.replaceChildren(el('p', 'error', CANNOT_INJECT));
      console.debug('Form Inspector: injection failed', err);
    }
  })();

  await Promise.all([forms, renderVisits(tab.url)]);
}
```

- [ ] **Step 3: Verify in Chrome**

1. Reload the extension. Open a page you have visited several times.

Expected: total visit count, first and last visit, and a reverse-chronological list of recent visits.

2. Submit a form somewhere, then open the popup on the resulting page.

Expected: that visit is tagged "form submit" and visually distinguished.

3. Open a URL with a fragment you have never visited exactly (e.g. append `#never-seen`).

Expected: "No recorded visits for this exact URL." — not an error.

4. Open `chrome://version`.

Expected: the Forms panel shows the cannot-inspect message **and** the Visits panel still renders. This is the independent-failure requirement.

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS, 35 tests.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.js
git commit -m "Add visit history section with form-submit transitions marked"
```

---

## Done

The extension is complete: load `src/` unpacked and the popup shows both lenses on the current page.

**Deferred from the spec, not built here:** fields rendered outside any `<form>` element. On pages that use no `<form>` (common in React applications), this extension correctly reports zero forms and shows nothing. Adding an `orphanFields` list to the extractor is the natural next increment.
