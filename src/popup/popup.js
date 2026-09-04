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
  '(chrome://, the Web Store, and the PDF viewer).';

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

  formsEl.addEventListener('mouseover', (event) => {
    const li = event.target.closest('li[data-field-index]');
    if (!li) return;
    const block = li.closest('[data-form-index]');
    send({
      type: 'highlight',
      formIndex: Number(block.dataset.formIndex),
      fieldIndex: Number(li.dataset.fieldIndex),
    });
  });

  formsEl.addEventListener('mouseout', (event) => {
    if (event.target.closest('li[data-field-index]')) send({ type: 'clearHighlight' });
  });

  window.addEventListener('pagehide', () => send({ type: 'clearHighlight' }));
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

async function loadVisits(url) {
  const [visits, matches] = await Promise.all([
    chrome.history.getVisits({ url }),
    chrome.history.search({ text: url, startTime: 0, maxResults: 100 }),
  ]);
  // search() matches substrings across URL and title, so narrow to this URL.
  const item = matches.find((m) => m.url === url) || null;
  return { visits, item };
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
  let visits;
  let item;
  try {
    ({ visits, item } = await loadVisits(url));
  } catch (err) {
    visitsEl.replaceChildren(el('p', 'error', 'Could not read history.'));
    console.debug('Form Inspector: history read failed', err);
    return;
  }

  visitsEl.replaceChildren();

  if (visits.length === 0) {
    visitsEl.appendChild(el('p', 'empty', 'No recorded visits for this exact URL.'));
    return;
  }

  const sorted = [...visits].sort((a, b) => b.visitTime - a.visitTime);
  const total = item ? item.visitCount : visits.length;
  visitsEl.appendChild(el('p', 'summary',
    `${total} visit${total === 1 ? '' : 's'} · first ${formatWhen(sorted[sorted.length - 1].visitTime)} · last ${formatWhen(sorted[0].visitTime)}`));

  const list = el('ul', 'visits');
  sorted.slice(0, 20).forEach((visit) => list.appendChild(visitRow(visit)));
  visitsEl.appendChild(list);

  if (sorted.length > 20) {
    visitsEl.appendChild(el('p', 'summary', `Showing the 20 most recent of ${sorted.length}.`));
  }
}

async function main() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    urlEl.textContent = 'No active tab.';
    return;
  }
  urlEl.textContent = tab.url;

  const forms = (async () => {
    try {
      const result = await scanForms(tab.id);
      renderForms(result.forms);
      wireHighlighting(tab.id);
    } catch (err) {
      formsEl.replaceChildren(el('p', 'error', CANNOT_INJECT));
      console.debug('Form Inspector: injection failed', err);
    }
  })();

  await Promise.all([forms, renderVisits(tab.url)]);
}

main();
