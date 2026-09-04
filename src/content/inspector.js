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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'scan') {
      const result = extractForms(document);
      rebuildCache();
      sendResponse(result);
    }
    return false;
  });
})();
