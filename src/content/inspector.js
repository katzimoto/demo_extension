'use strict';

(() => {
  if (window.__formInspectorReady) return;
  window.__formInspectorReady = true;

  // cache[formIndex][fieldIndex] -> Element. Built with formControls() so the
  // indices line up with the descriptors by construction.
  let cache = [];

  function rebuildCache() {
    cache = Array.from(document.forms).map((form) => formControls(form));
  }

  let overlay = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'z-index:2147483647',
      'outline:2px solid #e0a92a',
      'background:rgba(224,169,42,0.18)',
      'border-radius:2px',
      'display:none',
    ].join(';');
    document.body.appendChild(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  function highlight(target) {
    const rect = target.getBoundingClientRect();
    // Hidden inputs and display:none controls have no box to draw.
    if (rect.width === 0 && rect.height === 0) {
      hideOverlay();
      return false;
    }
    const box = ensureOverlay();
    box.style.top = `${rect.top + window.scrollY}px`;
    box.style.left = `${rect.left + window.scrollX}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.display = 'block';
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'scan') {
      const result = extractForms(document);
      rebuildCache();
      sendResponse(result);
    } else if (msg.type === 'highlight') {
      const target = (cache[msg.formIndex] || [])[msg.fieldIndex];
      sendResponse({ ok: target ? highlight(target) : false });
    } else if (msg.type === 'clearHighlight') {
      hideOverlay();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
