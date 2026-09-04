# Collector Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local `node:http` collector server, plus the extension-side plumbing that takes behavioural config from it and posts the forms found on each inspected page.

**Architecture:** The popup sends — no background service worker, matching the existing design. Two pure, unit-tested modules (`config.js`, `payload.js`) hold all the logic that decides *whether* and *what* to send; `popup.js` holds only the `chrome.*` glue. The server is dependency-free and exposes `createServer(store)` without listening, so integration tests bind it to an ephemeral port and prove the round trip in CI.

**Tech Stack:** Vanilla JavaScript, no build step. `node:http` (no framework). Chrome MV3 APIs (`scripting`, `tabs`, `history`, `storage`, `permissions`). `node --test` + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-04-collector-server-design.md`

## Global Constraints

- **Zero runtime dependencies.** `package.json` `dependencies` stays empty; `jsdom` remains the only devDependency. No Express, no node-fetch — Node 24's global `fetch` covers the tests.
- **The payload shape is fixed in client code.** `buildPayload` constructs exactly `sentAt`, `forms`, and conditionally `url`. No config value may add a key. This is the invariant that makes a configurable endpoint safe.
- **Typed field values are never sent.** The extractor never reads them; nothing here may change that.
- **Config fails closed.** Anything missing, malformed, or wrongly typed collapses to the narrower value: `enabled: false`, `collectUrl: false`, `minIntervalMs: 0`.
- **A failed config fetch means do not send, and must say so.** A server that is down must never be indistinguishable from a server that disabled sending.
- **The collector section fails independently** of the forms and visits sections, exactly as those two already do.
- Extension root is `src/`; Chrome loads `src/` unpacked. No build step.
- `package.json` omits `"type"` — tests are CommonJS.
- Files under 500 lines. Commit messages carry no `Co-Authored-By` trailer.

## Parallelism

**Track A (Tasks 1–2)** owns `server/` and `tests/server.test.js`.
**Track B (Tasks 3–4)** owns `src/lib/config.js`, `src/lib/payload.js`, `tests/config.test.js`, `tests/payload.test.js`.

The two tracks share no file and communicate only through the wire contract in the spec. They can run concurrently in separate worktrees.

**Tasks 5–7 are integration and run only after both tracks land.** They touch shared files (`src/manifest.json`, `package.json`, `src/popup/*`) and belong to a single integration owner. Never run them concurrently with anything.

**A note on test counts.** Tasks 1–2 state absolute totals (44, then 54) that
are correct *inside Track A's worktree*, which branches from the 38-test
baseline and never sees Track B's tests. Track B's tasks deliberately state
only how many tests they add, for the same reason. After both tracks merge the
total is 38 + 6 + 10 + 8 + 7 = 69. If your count disagrees with your task's
stated total, check which worktree you are in before assuming something broke.

**Neither track may touch `package.json`.** Task 2 adds a server that Task 5
wires up with an `npm run server` script; a Track A implementer who adds that
script themselves creates a merge conflict on a shared manifest, which is the
integration owner's file.

## File Structure

```
server/store.js            bounded in-memory record store (pure)
server/app.js              createServer(store) — routes, not listening
server/index.js            starts app.js on PORT
src/lib/config.js          normalizeConfig — pure, fails closed
src/lib/payload.js         buildPayload — pure, fixed shape
src/popup/popup.js         syncToServer glue (integration)
src/popup/popup.html       collector section (integration)
src/popup/popup.css        collector styles (integration)
src/manifest.json          storage + optional_host_permissions (integration)
tests/server.test.js       real round-trip over an ephemeral port
tests/config.test.js       fail-closed matrix
tests/payload.test.js      fixed-shape guarantee
```

---

### Task 1: Server — bounded record store

**Track A.** Owns `server/store.js` and its tests. Touches nothing else.

**Files:**
- Create: `server/store.js`
- Test: `tests/server.test.js` (create; Task 2 appends to it)

**Interfaces:**
- Consumes: nothing
- Produces: `createStore(max?) -> { add(payload), list(), clear(), size }`
  - `add` returns `{ id, receivedAt, payload }`; `id` is `"r-<n>"` with `n` incrementing per accepted record for the life of the process
  - `list()` returns records newest-first
  - bounded at 100 by default, dropping oldest

- [ ] **Step 1: Write the failing test**

Create `tests/server.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../server/store.js');

test('add returns a record with a sequential id', () => {
  const store = createStore();
  const first = store.add({ forms: [] });
  const second = store.add({ forms: [] });
  assert.equal(first.id, 'r-1');
  assert.equal(second.id, 'r-2');
  assert.equal(typeof first.receivedAt, 'number');
  assert.deepEqual(first.payload, { forms: [] });
});

test('list returns records newest first', () => {
  const store = createStore();
  store.add({ n: 1 });
  store.add({ n: 2 });
  assert.deepEqual(store.list().map((r) => r.payload.n), [2, 1]);
});

test('the store is bounded and drops the oldest', () => {
  const store = createStore(3);
  for (let n = 1; n <= 5; n += 1) store.add({ n });
  assert.equal(store.size, 3);
  assert.deepEqual(store.list().map((r) => r.payload.n), [5, 4, 3]);
});

test('ids stay unique after eviction', () => {
  const store = createStore(2);
  for (let n = 1; n <= 4; n += 1) store.add({ n });
  assert.deepEqual(store.list().map((r) => r.id), ['r-4', 'r-3']);
});

test('clear empties the store and resets ids', () => {
  const store = createStore();
  store.add({ n: 1 });
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.list(), []);
  assert.equal(store.add({ n: 2 }).id, 'r-1');
});

test('stores are independent', () => {
  const a = createStore();
  const b = createStore();
  a.add({ n: 1 });
  assert.equal(a.size, 1);
  assert.equal(b.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/store.js'`

- [ ] **Step 3: Write the implementation**

Create `server/store.js`:

```js
'use strict';

const MAX_RECORDS = 100;

function createStore(max = MAX_RECORDS) {
  const records = [];
  let nextId = 1;

  return {
    add(payload) {
      const record = { id: `r-${nextId}`, receivedAt: Date.now(), payload };
      nextId += 1;
      records.push(record);
      while (records.length > max) records.shift();
      return record;
    },
    list() {
      return [...records].reverse();
    },
    clear() {
      records.length = 0;
      nextId = 1;
    },
    get size() {
      return records.length;
    },
  };
}

module.exports = { createStore, MAX_RECORDS };
```

The id counter deliberately does not rewind on eviction — two records must never share an id within one process run.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 44 tests (38 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add server/store.js tests/server.test.js
git commit -m "Add bounded in-memory record store for the collector"
```

---

### Task 2: Server — routes and the round-trip proof

**Track A.** Owns `server/app.js`, `server/index.js`, and appends to `tests/server.test.js`.

**Files:**
- Create: `server/app.js`
- Create: `server/index.js`
- Test: `tests/server.test.js` (append)

**Interfaces:**
- Consumes: `createStore` from Task 1
- Produces: `createServer(store) -> http.Server` (NOT listening — the caller binds it, which is what makes it testable), and `MAX_BODY_BYTES`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server.test.js`:

```js
const { createServer } = require('../server/app.js');

async function withServer(run) {
  const store = createStore();
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SAMPLE = {
  sentAt: 1788523211007,
  url: 'https://example.com/login',
  forms: [
    { index: 0, id: 'login', name: '', action: '/session', method: 'post', fieldCount: 2,
      fields: [
        { index: 0, tag: 'input', type: 'email', name: 'email', id: 'e', label: 'Email', labelSource: 'for', required: true, disabled: false },
        { index: 1, tag: 'input', type: 'password', name: 'pw', id: '', label: null, labelSource: 'none', required: true, disabled: false },
      ] },
    { index: 1, id: '', name: 'search', action: '', method: 'get', fieldCount: 1,
      fields: [
        { index: 0, tag: 'input', type: 'text', name: 'q', id: '', label: 'Search', labelSource: 'placeholder', required: false, disabled: false },
      ] },
  ],
};

test('GET /config returns the documented shape', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(typeof body.collectUrl, 'boolean');
    assert.ok(Number.isInteger(body.minIntervalMs) && body.minIntervalMs >= 0);
  });
});

test('POST /collect accepts a payload and echoes recomputed counts', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 'r-1');
    assert.equal(body.formCount, 2);
    assert.equal(body.fieldCount, 3);
    assert.equal(typeof body.receivedAt, 'number');
  });
});

test('ROUND TRIP: what is posted comes back from /records', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE),
    });
    const res = await fetch(`${base}/records`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.records[0].id, 'r-1');
    assert.deepEqual(body.records[0].payload, SAMPLE);
  });
});

test('/records returns newest first', async () => {
  await withServer(async (base) => {
    for (const n of [1, 2, 3]) {
      await fetch(`${base}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentAt: n, forms: [] }),
      });
    }
    const body = await (await fetch(`${base}/records`)).json();
    assert.deepEqual(body.records.map((r) => r.payload.sentAt), [3, 2, 1]);
  });
});

test('malformed bodies are rejected with 400', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('[]')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post(JSON.stringify({ sentAt: 1 }))).status, 400);
    assert.equal((await post(JSON.stringify({ forms: 'nope' }))).status, 400);
  });
});

test('a rejected body is not stored', async () => {
  await withServer(async (base, store) => {
    await fetch(`${base}/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
    });
    assert.equal(store.size, 0);
  });
});

test('wrong methods get 405', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/config`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/records`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/collect`, { method: 'GET' })).status, 405);
  });
});

test('an oversized body gets 413', async () => {
  await withServer(async (base) => {
    const huge = JSON.stringify({ sentAt: 1, forms: [], pad: 'x'.repeat(1024 * 1024 + 16) });
    const res = await fetch(`${base}/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: huge,
    });
    assert.equal(res.status, 413);
  });
});

test('unknown paths get 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('preflight is answered with CORS headers', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/collect`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/app.js'`

- [ ] **Step 3: Write the server**

Create `server/app.js`:

```js
'use strict';

const http = require('node:http');

const MAX_BODY_BYTES = 1024 * 1024;

// Served by GET /config. Constants for now — there is deliberately no admin
// route to change them at runtime.
const CONFIG = { enabled: true, collectUrl: true, minIntervalMs: 0 };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('payload too large');
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function countFields(forms) {
  return forms.reduce(
    (total, form) => total + (Array.isArray(form.fields) ? form.fields.length : 0),
    0
  );
}

async function handleCollect(req, res, store) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      return json(res, 413, { ok: false, error: 'payload too large' });
    }
    return json(res, 400, { ok: false, error: 'could not read body' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { ok: false, error: 'body is not valid JSON' });
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return json(res, 400, { ok: false, error: 'body must be a JSON object' });
  }
  if (!Array.isArray(payload.forms)) {
    return json(res, 400, { ok: false, error: 'forms must be an array' });
  }

  const record = store.add(payload);
  return json(res, 201, {
    ok: true,
    id: record.id,
    receivedAt: record.receivedAt,
    formCount: payload.forms.length,
    fieldCount: countFields(payload.forms),
  });
}

function createServer(store) {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/config') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      json(res, 200, CONFIG);
      return;
    }

    if (pathname === '/records') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      const records = store.list();
      json(res, 200, { count: records.length, records });
      return;
    }

    if (pathname === '/collect') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      handleCollect(req, res, store).catch(() => {
        json(res, 400, { ok: false, error: 'could not process request' });
      });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  });
}

module.exports = { createServer, MAX_BODY_BYTES };
```

`createServer` returns a server that is not listening. That is the whole reason the round-trip test can exist: it binds to port 0 and gets an ephemeral port, so tests never collide with a running dev server or with each other.

- [ ] **Step 4: Write the entrypoint**

Create `server/index.js`:

```js
'use strict';

const { createServer } = require('./app.js');
const { createStore } = require('./store.js');

const PORT = Number(process.env.PORT) || 3000;

createServer(createStore()).listen(PORT, () => {
  console.log(`Form Inspector collector listening on http://localhost:${PORT}`);
  console.log(`  GET  /config   behaviour for the extension`);
  console.log(`  POST /collect  receive a payload`);
  console.log(`  GET  /records  everything received so far`);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 54 tests (44 after Task 1 + 10 new).

- [ ] **Step 6: Commit**

```bash
git add server/app.js server/index.js tests/server.test.js
git commit -m "Add collector server routes with a round-trip test"
```

---

### Task 3: Extension — config normalisation

**Track B.** Owns `src/lib/config.js` and `tests/config.test.js`. Touches nothing else.

**Files:**
- Create: `src/lib/config.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeConfig(raw: unknown) -> { enabled: boolean, collectUrl: boolean, minIntervalMs: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.js`:

```js
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
```

The "unknown keys are dropped" test is the one that matters most: it proves a
server cannot smuggle a `collectValues` flag through the config into anything
downstream.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/config.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/config.js`:

```js
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
```

`=== true` rather than a truthiness check is deliberate: a server returning
`"enabled": "false"` (a non-empty string, therefore truthy) must not enable
sending.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 8 new tests in `tests/config.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.js tests/config.test.js
git commit -m "Add fail-closed config normalisation for the collector"
```

---

### Task 4: Extension — payload construction

**Track B.** Owns `src/lib/payload.js` and `tests/payload.test.js`.

**Files:**
- Create: `src/lib/payload.js`
- Test: `tests/payload.test.js`

**Interfaces:**
- Consumes: `normalizeConfig` from Task 3 (only in tests, to build realistic configs); `extractForms` from `src/lib/form-extractor.js` (existing, for the cross-module guard)
- Produces: `buildPayload(forms, url, now, config) -> { sentAt, forms, url? }`

- [ ] **Step 1: Write the failing test**

Create `tests/payload.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { buildPayload } = require('../src/lib/payload.js');
const { normalizeConfig } = require('../src/lib/config.js');
const { extractForms } = require('../src/lib/form-extractor.js');

const FORMS = [{ index: 0, id: 'f', name: '', action: '/x', method: 'get', fieldCount: 0, fields: [] }];

test('includes url when collectUrl is true', () => {
  const payload = buildPayload(FORMS, 'https://example.com/a', 123, {
    enabled: true, collectUrl: true, minIntervalMs: 0,
  });
  assert.equal(payload.url, 'https://example.com/a');
  assert.equal(payload.sentAt, 123);
  assert.deepEqual(payload.forms, FORMS);
});

test('omits url entirely when collectUrl is false', () => {
  const payload = buildPayload(FORMS, 'https://example.com/a', 123, {
    enabled: true, collectUrl: false, minIntervalMs: 0,
  });
  assert.ok(!('url' in payload), 'url key must be absent, not undefined');
  assert.deepEqual(Object.keys(payload).sort(), ['forms', 'sentAt']);
});

test('a missing or malformed config omits the url', () => {
  for (const config of [undefined, null, {}, { collectUrl: 'true' }]) {
    const payload = buildPayload(FORMS, 'https://example.com/a', 1, config);
    assert.ok(!('url' in payload), `config ${JSON.stringify(config)}`);
  }
});

test('FIXED SHAPE: no config value can add a key', () => {
  const hostile = normalizeConfig({
    enabled: true, collectUrl: true, minIntervalMs: 0,
    collectValues: true, includeCookies: true, extraFields: ['password'],
  });
  const payload = buildPayload(FORMS, 'https://example.com/a', 1, hostile);
  assert.deepEqual(Object.keys(payload).sort(), ['forms', 'sentAt', 'url']);
});

test('FIXED SHAPE: raw unnormalised config cannot add a key either', () => {
  const payload = buildPayload(FORMS, 'https://example.com/a', 1, {
    collectUrl: true, collectValues: true, secrets: 'yes',
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
    enabled: true, collectUrl: true, minIntervalMs: 0,
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
  buildPayload(FORMS, 'https://example.com/a', 1, { collectUrl: true });
  assert.deepEqual(FORMS, original);
});
```

The cross-module guard is the important one. The extractor has its own value-policy tests, but this is the only test that asserts the property survives all the way to the bytes that would go on the wire.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/payload.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/payload.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 7 new tests in `tests/payload.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payload.js tests/payload.test.js
git commit -m "Add payload builder with a fixed, config-proof shape"
```

---

### Task 5: Integration — manifest, markup, styles, npm script

**Integration owner only.** Runs after Tracks A and B have both landed. Touches shared files.

**Files:**
- Modify: `src/manifest.json`
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.css`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: DOM id `collector`, button id `connect`, CSS classes `ok`/`muted`, npm script `server`

- [ ] **Step 1: Update the manifest**

`src/manifest.json` — add `"storage"` to `permissions` and add `optional_host_permissions`:

```json
{
  "manifest_version": 3,
  "name": "Form Inspector",
  "version": "0.2.0",
  "description": "Inspect the forms on the current page alongside your visit history for it.",
  "permissions": ["activeTab", "scripting", "history", "storage"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "action": {
    "default_title": "Form Inspector",
    "default_popup": "popup/popup.html"
  }
}
```

`optional_host_permissions` declares the ability to *ask* for an origin. It grants nothing: the extension holds no host access until the user approves a specific origin at runtime, and Chrome names that exact origin in its prompt. Still no `host_permissions`, no `content_scripts`, no `background`.

- [ ] **Step 2: Add the collector section to the popup**

In `src/popup/popup.html`, after the Visits `<section>` and before `<script src="popup.js"></script>`:

```html
    <section>
      <h2>Collector</h2>
      <div id="collector" class="panel">Checking&hellip;</div>
    </section>
```

- [ ] **Step 3: Add the styles**

Append to `src/popup/popup.css`:

```css
button {
  font: inherit;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
}

button:hover { border-color: var(--accent); }

.ok { color: var(--fg); }
.muted { color: var(--muted); }

.endpoint {
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  word-break: break-all;
  margin-top: 4px;
}
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add to `scripts`:

```json
"server": "node server/index.js"
```

The full `scripts` block becomes:

```json
  "scripts": {
    "test": "node --test",
    "server": "node server/index.js"
  },
```

`dependencies` stays absent; `devDependencies` keeps only `jsdom`.

- [ ] **Step 5: Verify nothing regressed**

Run: `npm test`
Expected: PASS, same count as after Task 4 — this task adds no tests and must break none.

Also confirm the manifest is still valid JSON and free of forbidden keys:

```bash
node -e "const m=require('./src/manifest.json');
for (const k of ['host_permissions','content_scripts','background'])
  if (k in m) throw new Error('forbidden key: '+k);
console.log('permissions:', m.permissions.join(', '));
console.log('optional:', m.optional_host_permissions.join(', '));"
```
Expected: `permissions: activeTab, scripting, history, storage` and no throw.

- [ ] **Step 6: Commit**

```bash
git add src/manifest.json src/popup/popup.html src/popup/popup.css package.json
git commit -m "Add collector permissions, popup section and server script"
```

---

### Task 6: Integration — the send path

**Integration owner only.** The `chrome.*` glue. All decision logic already lives in the tested pure modules; this task must not reimplement any of it.

**Files:**
- Modify: `src/popup/popup.js`

**Interfaces:**
- Consumes: `normalizeConfig` (Task 3), `buildPayload` (Task 4), `el`, `formsEl`, `getActiveTab` (existing), DOM id `collector` (Task 5)
- Produces: nothing downstream — this is the last code task

- [ ] **Step 1: Add the collector module scope**

At the top of `src/popup/popup.js`, alongside the other element consts, add:

```js
const collectorEl = document.getElementById('collector');
const DEFAULT_ENDPOINT = 'http://localhost:3000';
```

`popup.html` loads `popup.js` as a classic script, so `normalizeConfig` and `buildPayload` are not importable here. Add them to the popup's script tags instead — in `src/popup/popup.html`, immediately BEFORE `<script src="popup.js"></script>`:

```html
    <script src="../lib/config.js"></script>
    <script src="../lib/payload.js"></script>
```

Both files declare their functions at top level and guard their `module.exports`, so they work unchanged in both the browser and the Node tests.

- [ ] **Step 2: Add the storage and permission helpers**

```js
async function getEndpoint() {
  const stored = await chrome.storage.local.get('endpoint');
  return stored.endpoint || DEFAULT_ENDPOINT;
}

function originPattern(endpoint) {
  return `${new URL(endpoint).origin}/*`;
}

async function hasOriginAccess(endpoint) {
  return chrome.permissions.contains({ origins: [originPattern(endpoint)] });
}

async function lastSentAt(url) {
  const key = `lastSent:${url}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || 0;
}

async function markSent(url, when) {
  await chrome.storage.local.set({ [`lastSent:${url}`]: when });
}
```

The throttle key is always the real page URL, even when `collectUrl` is false — throttling is a local decision, and suppressing the URL in the payload does not mean the extension forgets which page it is on.

- [ ] **Step 3: Add the connect affordance**

```js
function renderConnect(endpoint) {
  collectorEl.replaceChildren();
  collectorEl.appendChild(el('p', 'muted', 'Not connected to a collector.'));

  const button = el('button', null, 'Connect to server');
  button.addEventListener('click', async () => {
    const granted = await chrome.permissions.request({
      origins: [originPattern(endpoint)],
    });
    if (granted) {
      collectorEl.replaceChildren(el('p', 'muted', 'Connected. Reopen the popup to send.'));
    } else {
      collectorEl.replaceChildren(el('p', 'muted', 'Permission declined.'));
    }
  });
  collectorEl.appendChild(button);
  collectorEl.appendChild(el('p', 'endpoint', endpoint));
}
```

`chrome.permissions.request()` requires a user gesture, which is why this is a button and not something the popup can do on open. That is a Chrome constraint, not a design choice.

- [ ] **Step 4: Add the send path**

```js
async function syncToServer(url, forms) {
  const endpoint = await getEndpoint();

  if (!(await hasOriginAccess(endpoint))) {
    renderConnect(endpoint);
    return;
  }

  let config;
  try {
    const res = await fetch(`${endpoint}/config`);
    if (!res.ok) throw new Error(`config responded ${res.status}`);
    config = normalizeConfig(await res.json());
  } catch (err) {
    collectorEl.replaceChildren(
      el('p', 'error', 'Collector unreachable — nothing was sent.'),
      el('p', 'endpoint', endpoint)
    );
    console.warn('Form Inspector: config fetch failed', err);
    return;
  }

  if (!config.enabled) {
    collectorEl.replaceChildren(el('p', 'muted', 'Sending disabled by the server.'));
    return;
  }

  const now = Date.now();
  const previous = await lastSentAt(url);
  if (config.minIntervalMs > 0 && now - previous < config.minIntervalMs) {
    const wait = Math.ceil((config.minIntervalMs - (now - previous)) / 1000);
    collectorEl.replaceChildren(
      el('p', 'muted', `Throttled by the server — ${wait}s until the next send.`)
    );
    return;
  }

  const payload = buildPayload(forms, url, now, config);

  try {
    const res = await fetch(`${endpoint}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      collectorEl.replaceChildren(
        el('p', 'error', `Server rejected the payload (${res.status}): ${body.error || 'no reason given'}`)
      );
      return;
    }

    await markSent(url, now);
    collectorEl.replaceChildren(
      el('p', 'ok',
        `Sent — server received ${body.formCount} form${body.formCount === 1 ? '' : 's'}, ` +
        `${body.fieldCount} field${body.fieldCount === 1 ? '' : 's'} as ${body.id}.`),
      el('p', 'muted', config.collectUrl ? 'Page URL included.' : 'Page URL withheld by server config.'),
      el('p', 'endpoint', endpoint)
    );
  } catch (err) {
    collectorEl.replaceChildren(el('p', 'error', 'Send failed.'));
    console.warn('Form Inspector: send failed', err);
  }
}
```

The receipt deliberately quotes the server's own recomputed counts rather than the extension's — that is what makes it evidence the data arrived intact rather than a claim that it was dispatched.

- [ ] **Step 5: Wire it into `main`, preserving independent failure**

In `main`, inside the existing forms async IIFE, after `wireHighlighting(tab.id)`:

```js
      await syncToServer(tab.url, result.forms);
```

It goes inside the render `try`, after `wireHighlighting`, so a collector failure cannot prevent forms or highlighting from working — and because `syncToServer` handles all its own errors internally, it cannot reject `Promise.all` and blank the visits section. If injection fails, `syncToServer` never runs, and the collector panel keeps its initial text; that is correct, since there are no forms to send.

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: PASS, same count as after Task 5 — this task adds no tests.

Run: `node --check src/popup/popup.js`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/popup/popup.js src/popup/popup.html
git commit -m "Send scanned forms to the configured collector"
```

---

### Task 7: Correct the artefacts this work invalidated

**Integration owner only.** The spec names three artefacts that become wrong; leaving them standing would be worse than the change itself.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-form-inspector-extension-design.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Correct the permissions table**

In the Form Inspector spec, the permissions table gains a row and the surrounding prose must stop claiming there is no egress:

```markdown
| `storage`   | Persist the collector endpoint and per-URL send timestamps |
```

- [ ] **Step 2: Correct the "Consequences" list**

The list under "Decision: programmatic injection, not a declared content script" currently states the extension has no host permissions. Replace that bullet with:

```markdown
- No `host_permissions` in the manifest. The extension has access to a tab
  only after you click its icon, and only to that tab. Since the collector
  was added it also declares `optional_host_permissions`, which grants
  nothing until the user approves a specific origin at runtime — see
  `2026-09-04-collector-server-design.md`.
```

- [ ] **Step 3: Add a pointer to the collector spec**

Immediately after the Purpose section, add:

```markdown
**Egress:** this extension sends form structure to a configurable collector.
See `docs/superpowers/specs/2026-09-04-collector-server-design.md`. Typed field
values and visit history are never sent.
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "Correct the Form Inspector spec now that the extension has egress"
```

- [ ] **Step 5: Update the PR description**

The description on PR #1 states the extension has no way to send data anywhere. Update it with the collector's addition and the fact that typed values and visit history are still excluded:

```bash
gh pr view 1 --json body -q .body > /tmp/pr-body-old.md
```

Edit to correct the egress claims, then:

```bash
gh pr edit 1 --body-file <edited file>
```

This step is a side effect outside the repository. Confirm with the human partner before running it.

---

## Done

`npm run server` starts the collector; `npm test` proves the round trip without a browser.

**Still requires a human in a browser:** loading `src/` unpacked, clicking "Connect to server", approving the origin, and confirming that a popup open lands a record visible at `http://localhost:3000/records` — and that stopping the server produces "Collector unreachable" rather than silence.
