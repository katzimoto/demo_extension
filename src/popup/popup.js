'use strict';

const urlEl = document.getElementById('page-url');
const formsEl = document.getElementById('forms');
const visitsEl = document.getElementById('visits');

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const CANNOT_INJECT =
  'This page cannot be inspected. Chrome blocks extensions on browser pages ' +
  '(chrome://, the Web Store, and the PDF viewer), or local files unless you ' +
  "enable 'Allow access to file URLs' for this extension.";

// Ping the content script before injecting. form-extractor.js declares its
// lookup sets as top-level `const`s, which live in the isolated world's
// shared global lexical environment; re-running executeScript on a tab that
// already has the script loaded throws a redeclaration SyntaxError before
// inspector.js's own re-injection guard ever runs. Sending `scan` first and
// only falling back to executeScript when that rejects (no listener yet, or
// the world was torn down by a navigation) avoids ever re-injecting into a
// frame that's still alive. Do not "simplify" this back to an unconditional
// executeScript.
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
    return;
  }
  if (!tab.url) {
    urlEl.textContent = 'Active tab has no URL.';
    return;
  }
  urlEl.textContent = tab.url;

  const forms = (async () => {
    let result;
    try {
      result = await scanForms(tab.id);
    } catch (err) {
      formsEl.replaceChildren(el('p', 'error', CANNOT_INJECT));
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
  })();

  await Promise.all([forms, renderVisits(tab.url)]);
}

main().catch((err) => {
  console.error('Form Inspector: popup failed', err);
});
