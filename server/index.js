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
