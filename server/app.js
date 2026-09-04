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
        chunks.length = 0;
        req.resume();
        reject(err);
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
