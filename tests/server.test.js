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
