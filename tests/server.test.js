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
