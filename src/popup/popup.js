'use strict';

const urlEl = document.getElementById('page-url');
const formsEl = document.getElementById('forms');
const visitsEl = document.getElementById('visits');

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function main() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    urlEl.textContent = 'No active tab.';
    return;
  }
  urlEl.textContent = tab.url;
}

main();
