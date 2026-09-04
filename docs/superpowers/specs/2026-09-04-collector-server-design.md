# Collector Server — Design

**Date:** 2026-09-04
**Status:** Approved for planning
**Extends:** `docs/superpowers/specs/2026-09-04-form-inspector-extension-design.md`

## Purpose

A local collector server, plus the extension-side plumbing to send it the
forms found on each inspected page and to take its behavioural configuration
from it.

## What this reverses

The Form Inspector spec records "no `host_permissions`, no `<all_urls>`" as a
deliberate design decision, and states that the extension has no egress path.
That stops being true here. Three artefacts become wrong and must be corrected
as part of this work:

1. The Form Inspector spec's permissions table and its "Consequences" list.
2. The description on PR #1.
3. Any standing claim that the extension cannot send data anywhere.

Leaving those uncorrected would be worse than the change itself.

## Non-goals

- **Typed field values are never sent.** The extractor does not read them, and
  no server response can make it. See "Config authority" below.
- **Visit history is not sent.** `chrome.history` data stays on the machine.
- **No disk persistence by default.** The server holds records in memory and
  forgets them on restart. A demo collector that silently accumulates a file of
  every page you inspected is a worse default than one that forgets.
- **No retry, batching, or offline queue.** The popup sends; if the popup
  closes mid-flight the send dies.

## Architecture

### Decision: the popup sends

The extension declares no `background` key — a deliberate decision in the
existing design. Sending from an MV3 service worker would buy retry and
batching this does not need, at the cost of reversing a second recorded
decision. Sending from the content script would need host permissions in the
page's context and mixes concerns. The popup already orchestrates the scan and
the history read; sending belongs there.

Consequence, accepted: closing the popup mid-send aborts the send.

### The wire contract

This section is the seam. The server and the extension-side modules are built
against it independently; nothing else couples them.

Base URL is configurable, default `http://localhost:3000`.

#### `GET /config`

200, `application/json`:

```json
{ "enabled": true, "collectUrl": true, "minIntervalMs": 0 }
```

| Field | Type | Meaning |
|-------|------|---------|
| `enabled` | boolean | when false the extension sends nothing |
| `collectUrl` | boolean | when false the payload omits `url` entirely |
| `minIntervalMs` | integer ≥ 0 | minimum gap between sends for one URL |

#### `POST /collect`

Request, `application/json`:

```json
{
  "sentAt": 1788523211007,
  "url": "https://example.com/login",
  "forms": [ /* FormDescriptor[], exactly as form-extractor.js produces */ ]
}
```

`url` is present only when `collectUrl` is true. `forms` is passed through
unmodified from the extractor.

201 on success:

```json
{ "ok": true, "id": "r-1", "receivedAt": 1788523211123,
  "formCount": 2, "fieldCount": 7 }
```

`formCount` is `forms.length`; `fieldCount` is the sum of each form's
`fields.length`. `id` is `"r-"` followed by a counter that increments per
accepted record for the life of the process.

The echoed `formCount` and `fieldCount` are deliberate: they let the popup show
a real receipt ("server received 2 forms, 7 fields") rather than a bare `ok`,
which is what makes the round trip visible. Because the server recomputes them
from the payload rather than trusting a client-supplied count, they also
confirm the body survived transit intact.

Errors, all `{ "ok": false, "error": "<reason>" }`:

| Status | Condition |
|--------|-----------|
| 400 | body is not JSON, not an object, or `forms` is not an array |
| 405 | method other than POST on this path |
| 413 | body exceeds 1 MB |

#### `GET /records`

200:

```json
{ "count": 3,
  "records": [ { "id": "r-1", "receivedAt": 1788523211123, "payload": { } } ] }
```

Newest first. This route exists so a human can see that data arrived.

#### CORS

All routes answer `OPTIONS` preflight and send
`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST,
OPTIONS`, `Access-Control-Allow-Headers: Content-Type`. MV3 extension pages
holding a matching host permission are not subject to CORS, so this is
belt-and-braces — it costs three lines and removes a whole class of confusing
failure.

## Server

`server/`, plain `node:http`. No framework, no dependencies — the project has
zero runtime dependencies today and pulling in Express for three routes would
end that for no gain.

- `server/store.js` — the record store: `add(payload)`, `list()`, `clear()`.
  Bounded at 100 records, dropping oldest. Pure, no I/O, unit-testable.
- `server/app.js` — `createServer(store)` returning a `http.Server` that is
  **not** listening. This is the seam that makes the server testable: tests
  bind it to port 0 and get an ephemeral port.
- `server/index.js` — starts `createServer` on `PORT` (default 3000) when run
  directly. `npm run server`.

Config values served by `GET /config` are module-level constants in `app.js`
for now; there is no admin route to change them, and adding one is out of scope.

## Extension

### `src/lib/config.js` — pure

```
normalizeConfig(raw: unknown) -> { enabled, collectUrl, minIntervalMs }
```

**Fails closed.** Anything missing, malformed, or of the wrong type collapses
to the *narrower* value: `enabled: false`, `collectUrl: false`,
`minIntervalMs: 0`. A garbled config must never result in more collection than
a well-formed one.

### `src/lib/payload.js` — pure

```
buildPayload(forms, url, now, config) -> { sentAt, url?, forms }
```

No `chrome.*`, no network, no rendering — the same shape as
`form-extractor.js`, and for the same reason. **This module is where the
"payload shape is fixed" invariant lives**, so it is where a regression test
can prove no config widens it. It constructs exactly three keys, omitting `url`
when `config.collectUrl` is not true. It never reads from `forms` beyond
passing the array through.

### `src/popup/popup.js`

A `syncToServer(url, forms)` step, running after `renderForms`:

1. If the configured origin is not granted, render the "Connect to server"
   affordance and stop.
2. `GET /config` → `normalizeConfig`.
3. If `enabled` is false, or the last send for this URL was under
   `minIntervalMs` ago, render why and stop.
4. `buildPayload` → `POST /collect`.
5. Render the server's receipt, or the failure.

**A failed config fetch means do not send**, and it must say so. A server that
is down must not become indistinguishable from a server that disabled sending.

The last-send timestamp is keyed by page URL in `chrome.storage.local`,
alongside the configured endpoint. Note the key is always the real URL even
when `collectUrl` is false — throttling is a local decision, and suppressing
the URL in the payload does not mean the extension has to forget which page it
is on.

### Permissions

Added to `permissions`: `"storage"` — required to persist the configured
endpoint and the per-URL send timestamps.

Added: `optional_host_permissions: ["http://*/*", "https://*/*"]`.

This declares the *ability to ask* for any origin. It grants nothing. The
extension holds no host access until the user approves a specific origin at
runtime, and Chrome names that exact origin in its prompt. The default endpoint
is `http://localhost:3000`.

`chrome.permissions.request()` requires a user gesture, so first run needs a
**"Connect to server"** click even though sending is automatic thereafter. That
is a Chrome constraint, not a design choice.

## Config authority: narrows, never widens

The server's config can disable sending, suppress the URL, or throttle. It
cannot cause the extension to collect anything the client does not already
build. The payload shape is constructed in `payload.js` from the extractor's
fixed descriptors; there is no code path from a config value to a new field,
and none to typed input, which the extractor never reads at all.

This is the property that makes a configurable endpoint safe: pointing the
extension at a hostile server yields a server that can turn collection *off*.

## Error handling

| Condition | Behaviour |
|-----------|-----------|
| Origin not granted | "Connect to server" affordance; no fetch attempted |
| `GET /config` fails | render "server unreachable"; send nothing |
| Config disables sending | render "sending disabled by server" |
| Throttled | render "throttled; last sent <when>" |
| `POST /collect` non-2xx | render the status and the server's `error` |
| `POST /collect` network error | render "send failed" |

The collector section must fail independently of the forms and visits sections,
exactly as those two already fail independently of each other.

## Testing

This is the first part of the project that can be verified end to end without a
browser, and the plan should exploit that.

**Unit, pure modules** — `tests/config.test.js`, `tests/payload.test.js`:
- every fail-closed path in `normalizeConfig` (missing, null, wrong types,
  negative interval, extra keys ignored)
- `buildPayload` omits `url` when `collectUrl` is false and includes it when true
- **regression guard:** no config value produces a key outside
  `{sentAt, url, forms}`, and a descriptor carrying a typed value cannot exist
  because the extractor never emits one — assert the built payload's serialized
  form contains no value key for text inputs

**Integration, real server** — `tests/server.test.js`:
- boot `createServer` on port 0
- `GET /config` returns the documented shape
- `POST /collect` with a real extractor payload returns 201 with matching
  `formCount`/`fieldCount`
- `GET /records` returns what was posted — **the send/receive proof**
- 400 on malformed body, 405 on wrong method, 413 on oversized body
- store bound: posting 101 records leaves 100, oldest dropped

Node's global `fetch` is used; no HTTP client dependency.

## Manual verification

Start the server, load `src/` unpacked, click "Connect to server" and approve
the origin, then open the popup on a page with forms and check `GET /records`
in a browser tab. Then stop the server and confirm the popup says the server is
unreachable rather than silently doing nothing.
