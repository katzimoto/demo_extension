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

function describeField(el, index) {
  return {
    index,
    tag: el.tagName.toLowerCase(),
    type: fieldType(el),
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    label: null,
    labelSource: 'none',
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
  };
}

function describeForm(form, index) {
  const fields = formControls(form).map((el, i) => describeField(el, i));
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
  return { forms: Array.from(doc.forms).map(describeForm) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractForms, formControls };
}
