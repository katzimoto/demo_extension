# Form Inspector — Chrome Extension Design

**Date:** 2026-09-04
**Status:** Approved for planning

## Purpose

A demo Chrome extension (Manifest V3) whose popup describes the page you
are currently on, through two lenses:

1. **Forms** — every `<form>` on the page, with a full field inventory.
   Hovering a field in the popup outlines that element on the live page.
2. **Visits** — your browsing history *for this exact URL*: how many times
   you have been here, when you first and last visited, and a timeline of
   recent visits.

The two halves meet at Chrome's visit *transition* types: a visit recorded
as `form_submit` is a visit that happened because a form on that page was
submitted. The popup calls those out.

## Non-goals

Explicitly excluded, decided during design:

- **Current field values.** The popup never displays what a user has typed.
  Only authored markup is read.
- **Submission capture.** No recording of submit events or submitted data.
- **Cross-page form records.** No storage of "page X had N forms". Nothing
  persists; every popup open is a fresh read.
- **Chrome autofill data.** No extension API exposes it.

## Architecture

### Decision: programmatic injection, not a declared content script

The inspector is injected on demand by the popup via
`chrome.scripting.executeScript`, under the `activeTab` permission. It is
**not** declared in `content_scripts`.

Consequences:

- No `host_permissions`, no `<all_urls>`. The extension has access to a tab
  only after you click its icon, and only to that tab.
- Nothing runs on pages you never inspect.
- The injected script persists for the life of that tab's page, so
  hover-to-highlight works after the initial scan without re-injecting.

The rejected alternative — a declared content script — would run on every
page and require broad host permissions, for no gain here.

### No background service worker

The popup is the only orchestrator. There is no event to handle while the
popup is closed, so the extension declares no background worker.

### Permissions

| Permission  | Why |
|-------------|-----|
| `activeTab` | Read the active tab's URL and inject into it, on user gesture |
| `scripting` | `chrome.scripting.executeScript` |
| `history`   | `chrome.history.getVisits` and `chrome.history.search` |

## File layout

The extension root is `src/` — load **`src/`** as the unpacked extension.
This keeps the repository root free of working files.

```
src/manifest.json
src/popup/popup.html
src/popup/popup.css
src/popup/popup.js
src/lib/form-extractor.js      pure DOM -> descriptors; the tested unit
src/content/inspector.js       message handling + highlight overlay
tests/form-extractor.test.js
package.json                   jsdom, the only devDependency
```

Both injected files run as classic scripts in the same isolated world, so
`inspector.js` can call `extractForms` directly. `form-extractor.js` ends
with a CommonJS export guard so Node tests can `require` the same file the
browser loads:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractForms };
}
```

`package.json` omits `"type"`, so the test files are CommonJS.

## Components

### `lib/form-extractor.js`

One exported pure function:

```
extractForms(doc: Document) -> { forms: FormDescriptor[] }
```

It touches no `chrome.*` API, performs no rendering, and mutates nothing.
This is the whole reason the module exists separately: it is the only part
with real logic, and it is testable under jsdom.

**FormDescriptor**

| Field | Notes |
|-------|-------|
| `index` | Position in `doc.forms`; the handle used for highlight messages |
| `id` | `""` when absent |
| `name` | `""` when absent |
| `action` | The authored attribute, not the resolved absolute URL |
| `method` | Lowercased; `"get"` when absent |
| `fieldCount` | `fields.length` |
| `fields` | `FieldDescriptor[]` |

Fields come from `form.elements`, not from descendant queries. That matters:
`form.elements` includes controls associated with the form by the `form="id"`
attribute even when they sit elsewhere in the DOM, and it is the same
collection the inspector caches element references from, which keeps
descriptor indices and cached elements aligned by construction.

**FieldDescriptor**

| Field | Notes |
|-------|-------|
| `index` | Position within this form's field list |
| `tag` | `"input"`, `"select"`, `"textarea"`, or `"button"` |
| `type` | Input type lowercased; `"select-one"`/`"select-multiple"`; `"textarea"`; for `<button>`, its `type` attribute defaulting to `"submit"` |
| `name` | `""` when absent |
| `id` | `""` when absent |
| `label` | Resolved accessible name, or `null` |
| `labelSource` | How `label` was resolved — see below |
| `required` | Boolean |
| `disabled` | Boolean |
| `value` | **Only** for `radio` and `checkbox`, and only the authored `value` attribute. Absent on every other type. |

The `value` restriction is the mechanical guarantee behind the "never show
typed values" non-goal: radio and checkbox `value` is markup the page author
wrote, never user input.

Hidden inputs are listed (name and type) but their values are not exposed —
they routinely carry CSRF tokens.

Submit buttons and `<button>` elements are included; they are form controls
and are informative in an inventory.

**Label resolution precedence** follows HTML-AAM accessible-name computation,
so `aria-*` outranks the native `<label>`:

1. `aria-labelledby` → concatenated text of the referenced elements → `"aria-labelledby"`
2. `aria-label` → `"aria-label"`
3. `<label for="...">` matching the field's `id` → `"for"`
4. An ancestor `<label>` wrapping the field → `"wrap"`
5. `placeholder` → `"placeholder"`
6. Nothing → `label` is `null`, `labelSource` is `"none"`

Each radio in a group is its own field entry; the `value` attribute is what
distinguishes them.

### `content/inspector.js`

Injected alongside the extractor. Responsibilities:

- Register a `chrome.runtime.onMessage` listener, guarded by a global flag so
  that re-opening the popup and re-injecting does not register a second
  listener.
- On `{type:'scan'}`: run `extractForms(document)`, cache the matching element
  references in an array indexed identically to the descriptors, and reply
  with the descriptors.
- On `{type:'highlight', formIndex, fieldIndex}`: position the overlay over
  that cached element.
- On `{type:'clearHighlight'}`: hide the overlay.

**Highlight mechanism.** A single reusable `<div>` appended to
`document.body`, positioned absolutely from the target's
`getBoundingClientRect()` plus `scrollX`/`scrollY`, with a high `z-index` and
`pointer-events: none`. The target element's own styles are never mutated —
nothing to restore incorrectly, and it works on elements that already have an
`outline`.

The popup clears the highlight on row `mouseout` and on its own `pagehide`,
so no overlay is left behind when the popup closes.

### `popup/`

On open:

1. `chrome.tabs.query({active: true, currentWindow: true})` → tab `id`, `url`
2. `chrome.scripting.executeScript` injecting
   `['lib/form-extractor.js', 'content/inspector.js']`
3. `chrome.tabs.sendMessage(tabId, {type:'scan'})` → descriptors
4. Concurrently, the history reads (below)
5. Render both sections

Steps 3 and 4 run concurrently; neither section blocks the other's render.

**Visits section.** `chrome.history.getVisits({url})` returns visit records
with `visitTime` and `transition`. `chrome.history.search({text: url,
startTime: 0})` supplies `title` and `visitCount` — `search` matches
substrings across URL and title, so results are filtered to an exact URL
match before use.

Displayed: total visit count, first visit, last visit, and the 20 most
recent visits with timestamp and transition type. Visits with transition
`form_submit` are visually distinguished.

## Error and empty states

| Condition | Behavior |
|-----------|----------|
| Injection rejected (`chrome://`, Web Store, PDF viewer, `file://` without opt-in) | Forms section explains the page cannot be inspected, and why. The visits section still renders — history works regardless. |
| Page has no forms | Explicit empty state, not a blank list |
| No visits for this URL | "No recorded visits for this exact URL." Expected when the URL carries a fragment or query that differs from what history stored. |

An injection failure must not blank the popup: the two sections fail
independently.

## Testing

`node --test tests/` with jsdom, one devDependency.

Only `form-extractor.js` is unit-tested — it holds all the logic. The
`chrome.*` glue and popup rendering are verified by hand in the browser;
automating them would mean a Puppeteer rig disproportionate to a demo.

Cases to cover:

- Multiple forms on a page; a page with zero forms
- `method` defaulting to `get`; case normalization of `method` and `type`
- Each label source, in precedence order, including `aria-labelledby`
  outranking a present `<label for>`
- A wrapping `<label>` with no `for`
- Placeholder-only fallback; a field with no label at all
- A radio group sharing one `name`, distinguished by `value`
- `<select>` (single and multiple) and `<textarea>`
- `required` and `disabled` flags
- A field with no `name` attribute
- Hidden input: listed, value not exposed
- **Regression guard:** set `.value` on a text input, assert the descriptor
  has no `value` key. This is the non-goal made executable.

Order of work is test-first on the extractor, then the chrome glue and
popup UI.

## Manual verification

Load `src/` unpacked, then check against a page with real forms: the field
list matches the page, hovering outlines the right element, the overlay
disappears when the popup closes, and the visits section shows a plausible
timeline. Confirm a `chrome://` page produces the explanatory message rather
than an empty or broken popup.

## Deferred

**Fields outside any `<form>`.** Many modern applications, React ones in
particular, render inputs with no enclosing `<form>` element. On such pages
this inspector will correctly report zero forms and show nothing. Adding an
`orphanFields` list to the extractor output would cover them cheaply and is
the most likely next increment, but it is outside "view forms on the page"
as scoped and is not part of this build.
