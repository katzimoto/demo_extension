'use strict';

(() => {
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
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  function highlight(target) {
    // Scroll before reading the rect: order matters, the rect must reflect
    // the post-scroll position. `block: 'nearest'` only scrolls (minimally)
    // when the element is out of view, so an on-screen field is untouched.
    // Without this, hovering a row on a form taller than the viewport could
    // outline something invisible, which reads as a broken feature.
    target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    const rect = target.getBoundingClientRect();
    // Hidden inputs and display:none controls have no box to draw. Use ||,
    // not &&: an element that is 0×20 (zero-width) still has no visible box
    // to outline and must not draw a zero-width overlay.
    if (rect.width === 0 || rect.height === 0) {
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

  // Always (re-)register the listener, removing any previous one first, so
  // re-injection into a surviving isolated world (e.g. after an extension
  // reload) binds a fresh listener closing over the fresh `cache` above
  // instead of leaving an orphaned listener from the old extension context.
  if (window.__formInspectorListener) {
    chrome.runtime.onMessage.removeListener(window.__formInspectorListener);
  }

  window.__formInspectorListener = (msg, _sender, sendResponse) => {
    if (msg.type === 'scan') {
      hideOverlay();
      const result = extractForms(document);
      rebuildCache();
      sendResponse(result);
    } else if (msg.type === 'highlight') {
      const target = (cache[msg.formIndex] || [])[msg.fieldIndex];
      if (target) {
        sendResponse({ ok: highlight(target) });
      } else {
        hideOverlay();
        sendResponse({ ok: false });
      }
    } else if (msg.type === 'clearHighlight') {
      hideOverlay();
      sendResponse({ ok: true });
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(window.__formInspectorListener);
})();
