'use strict';

const urlEl = document.getElementById('page-url');
const formsEl = document.getElementById('forms');
const visitsEl = document.getElementById('visits');
const collectorEl = document.getElementById('collector');
const DEFAULT_ENDPOINT = 'http://localhost:3000';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const CANNOT_INJECT =
  'This page cannot be inspected. Chrome blocks extensions on browser pages ' +
  '(chrome://, the Web Store, and the PDF viewer), or local files unless you ' +
  "enable 'Allow access to file URLs' for this extension.";

// Ping the content script before injecting: on a tab that already has the
// inspector, this avoids re-running both files on every popup open.
//
// This was originally a correctness guard. form-extractor.js declared its
// lookup sets as top-level `const`s, so re-injecting into a surviving isolated
// world threw a redeclaration SyntaxError. That hazard is now fixed at the
// source — the sets are `var` (redeclarable), and inspector.js re-registers its
// listener instead of returning early, which is also what lets a tab recover
// after an extension reload orphans its listener. So ping-first is an
// optimisation now rather than load-bearing. Keep it anyway: re-injecting on
// every popup open is pure waste.
async function scanForms(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'scan' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/form-extractor.js', 'content/inspector.js'],
    });
    return chrome.tabs.sendMessage(tabId, { type: 'scan' });
  }
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

function wireHighlighting(tabId) {
  const send = (message) => {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  };

  let current = null;

  formsEl.addEventListener('mouseover', (event) => {
    const li = event.target.closest('li[data-field-index]');
    if (!li || li === current) return;
    current = li;
    const block = li.closest('[data-form-index]');
    send({
      type: 'highlight',
      formIndex: Number(block.dataset.formIndex),
      fieldIndex: Number(li.dataset.fieldIndex),
    });
  });

  formsEl.addEventListener('mouseout', (event) => {
    const li = event.target.closest('li[data-field-index]');
    if (!li) return;
    // Still inside the same row (padding/gap crossed a child boundary) —
    // not a real exit, so don't clear-and-redraw.
    if (li.contains(event.relatedTarget)) return;
    current = null;
    send({ type: 'clearHighlight' });
  });

  window.addEventListener('pagehide', () => {
    current = null;
    send({ type: 'clearHighlight' });
  });
}

async function getEndpoint() {
  const stored = await chrome.storage.local.get('endpoint');
  const endpoint = stored.endpoint || DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported scheme ${parsed.protocol}`);
    }
  } catch (err) {
    console.warn('Form Inspector: stored endpoint unusable, using default', endpoint, err);
    return DEFAULT_ENDPOINT;
  }
  return endpoint;
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

async function syncToServer(url, forms) {
  let endpoint;
  let granted;
  try {
    endpoint = await getEndpoint();
    granted = await hasOriginAccess(endpoint);
  } catch (err) {
    collectorEl.replaceChildren(
      el('p', 'error', 'Could not read collector settings.')
    );
    console.warn('Form Inspector: collector setup failed', err);
    return;
  }

  if (!granted) {
    renderConnect(endpoint);
    return;
  }

  let config;
  try {
    const res = await fetch(`${endpoint}/config`, { signal: AbortSignal.timeout(5000) });
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

  if (forms.length === 0) {
    collectorEl.replaceChildren(
      el('p', 'muted', 'No forms on this page — nothing sent.')
    );
    return;
  }

  const now = Date.now();
  let previous;
  try {
    previous = await lastSentAt(url);
  } catch (err) {
    collectorEl.replaceChildren(
      el('p', 'error', 'Could not read collector settings.')
    );
    console.warn('Form Inspector: collector setup failed', err);
    return;
  }
  if (shouldThrottle(now, previous, config.minIntervalMs)) {
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
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      collectorEl.replaceChildren(
        el('p', 'error', `Server rejected the payload (${res.status}): ${body.error || 'no reason given'}`)
      );
      return;
    }

    collectorEl.replaceChildren(
      el('p', 'ok',
        `Sent — server received ${body.formCount} form${body.formCount === 1 ? '' : 's'}, ` +
        `${body.fieldCount} field${body.fieldCount === 1 ? '' : 's'} as ${body.id}.`),
      el('p', 'muted', config.includeUrl ? 'Page URL included.' : 'Page URL withheld by server config.'),
      el('p', 'endpoint', endpoint)
    );
  } catch (err) {
    collectorEl.replaceChildren(el('p', 'error', 'Send failed.'));
    console.warn('Form Inspector: send failed', err);
    return;
  }

  try {
    await markSent(url, now);
  } catch (err) {
    console.warn('Form Inspector: could not record send time', err);
  }
}

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

function visitRow(visit) {
  const li = el('li');
  li.appendChild(el('span', 'v-when', formatWhen(visit.visitTime)));
  const label = TRANSITION_LABELS[visit.transition] || visit.transition;
  const isSubmit = visit.transition === 'form_submit';
  li.appendChild(el('span', isSubmit ? 'v-trans v-submit' : 'v-trans', label));
  return li;
}

async function renderVisits(url) {
  try {
    const visits = await chrome.history.getVisits({ url });

    visitsEl.replaceChildren();

    if (visits.length === 0) {
      visitsEl.appendChild(el('p', 'empty', 'No recorded visits for this exact URL.'));
      return;
    }

    const sorted = [...visits].sort((a, b) => b.visitTime - a.visitTime);
    const total = visits.length;
    visitsEl.appendChild(el('p', 'summary',
      `${total} visit${total === 1 ? '' : 's'} · first ${formatWhen(sorted[sorted.length - 1].visitTime)} · last ${formatWhen(sorted[0].visitTime)}`));

    const list = el('ul', 'visits');
    sorted.slice(0, 20).forEach((visit) => list.appendChild(visitRow(visit)));
    visitsEl.appendChild(list);

    if (sorted.length > 20) {
      visitsEl.appendChild(el('p', 'summary', `Showing the 20 most recent of ${sorted.length}.`));
    }
  } catch (err) {
    visitsEl.replaceChildren(el('p', 'error', 'Could not read history.'));
    console.warn('Form Inspector: history read failed', err);
  }
}

async function main() {
  const tab = await getActiveTab();
  if (!tab) {
    urlEl.textContent = 'No active tab.';
    collectorEl.replaceChildren(el('p', 'muted', 'Nothing to send — no active tab.'));
    return;
  }
  if (!tab.url) {
    urlEl.textContent = 'Active tab has no URL.';
    collectorEl.replaceChildren(el('p', 'muted', 'Nothing to send — the tab has no URL.'));
    return;
  }
  urlEl.textContent = tab.url;

  const forms = (async () => {
    let result;
    try {
      result = await scanForms(tab.id);
    } catch (err) {
      formsEl.replaceChildren(el('p', 'error', CANNOT_INJECT));
      collectorEl.replaceChildren(
        el('p', 'muted', 'Nothing to send — the page could not be scanned.')
      );
      console.warn('Form Inspector: scan failed', err);
      return;
    }
    try {
      renderForms(result.forms);
      wireHighlighting(tab.id);
    } catch (err) {
      formsEl.replaceChildren(el('p', 'error', 'Could not render the form list.'));
      console.error('Form Inspector: render failed', err);
    }
    try {
      await syncToServer(tab.url, result.forms);
    } catch (err) {
      collectorEl.replaceChildren(el('p', 'error', 'Collector sync failed.'));
      console.error('Form Inspector: sync failed', err);
    }
  })();

  await Promise.all([forms, renderVisits(tab.url)]);
}

main().catch((err) => {
  console.error('Form Inspector: popup failed', err);
});
