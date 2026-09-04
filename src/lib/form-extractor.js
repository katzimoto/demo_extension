'use strict';

const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);

function formControls(form) {
  return Array.from(form.elements).filter(
    (el) => CONTROL_TAGS.has(el.tagName.toLowerCase())
  );
}

function fieldType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') return el.multiple ? 'select-multiple' : 'select-one';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'button') return (el.getAttribute('type') || 'submit').toLowerCase();
  return (el.getAttribute('type') || 'text').toLowerCase();
}

function collapseWs(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function textOf(el) {
  return el ? collapseWs(el.textContent) : '';
}

function wrappingLabelText(label) {
  const clone = label.cloneNode(true);
  clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
  return textOf(clone);
}

function labelForId(doc, id) {
  if (!id) return null;
  for (const label of doc.querySelectorAll('label[for]')) {
    if (label.getAttribute('for') === id) return label;
  }
  return null;
}

function resolveLabel(el, doc) {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(doc.getElementById(id)))
      .filter(Boolean)
      .join(' ');
    if (text) return { label: text, labelSource: 'aria-labelledby' };
  }

  const ariaLabel = collapseWs(el.getAttribute('aria-label') || '');
  if (ariaLabel) return { label: ariaLabel, labelSource: 'aria-label' };

  const forLabel = labelForId(doc, el.getAttribute('id'));
  if (forLabel) {
    const text = textOf(forLabel);
    if (text) return { label: text, labelSource: 'for' };
  }

  const wrapping = el.closest('label');
  if (wrapping) {
    const text = wrappingLabelText(wrapping);
    if (text) return { label: text, labelSource: 'wrap' };
  }

  const placeholder = collapseWs(el.getAttribute('placeholder') || '');
  if (placeholder) return { label: placeholder, labelSource: 'placeholder' };

  return { label: null, labelSource: 'none' };
}

function describeField(el, index, doc) {
  const { label, labelSource } = resolveLabel(el, doc);
  return {
    index,
    tag: el.tagName.toLowerCase(),
    type: fieldType(el),
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    label,
    labelSource,
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
  };
}

function describeForm(form, index, doc) {
  const fields = formControls(form).map((el, i) => describeField(el, i, doc));
  return {
    index,
    id: form.getAttribute('id') || '',
    name: form.getAttribute('name') || '',
    action: form.getAttribute('action') || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fieldCount: fields.length,
    fields,
  };
}

function extractForms(doc) {
  return { forms: Array.from(doc.forms).map((form, i) => describeForm(form, i, doc)) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractForms, formControls };
}
