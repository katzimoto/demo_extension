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
