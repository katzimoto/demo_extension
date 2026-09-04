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

async function scanForms(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['lib/form-extractor.js', 'content/inspector.js'],
  });
  return chrome.tabs.sendMessage(tabId, { type: 'scan' });
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

async function main() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    urlEl.textContent = 'No active tab.';
    return;
  }
  urlEl.textContent = tab.url;

  try {
    const { forms } = await scanForms(tab.id);
    renderForms(forms);
  } catch (err) {
    formsEl.replaceChildren(el('p', 'error', CANNOT_INJECT));
    console.debug('Form Inspector: injection failed', err);
  }
}

main();
