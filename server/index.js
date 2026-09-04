'use strict';

const { createServer } = require('./app.js');
const { createStore } = require('./store.js');

const PORT = Number(process.env.PORT) || 3000;

// Bound to loopback deliberately: /records is unauthenticated and holds the
// URL and form structure of every inspected page, so it must not be
// reachable off-host.
createServer(createStore()).listen(PORT, '127.0.0.1', () => {
  console.log(`Form Inspector collector listening on http://localhost:${PORT}`);
  console.log(`  GET  /config   behaviour for the extension`);
  console.log(`  POST /collect  receive a payload`);
  console.log(`  GET  /records  everything received so far`);
});
