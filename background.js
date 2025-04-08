/* global browser */

let wasActive = new Set();
let awaitsActivation = new Map();
let regexList;
let mode;

async function getFromStorage(type, id, fallback) {
  let tmp = await browser.storage.local.get(id);
  return typeof tmp[id] === type ? tmp[id] : fallback;
}

async function setToStorage(id, value) {
  let obj = {};
  obj[id] = value;
  return browser.storage.local.set(obj);
}

async function getRegexList() {
  let out = [];
  let tmp = await getFromStorage("string", "matchers", "");
  tmp.split("\n").forEach((line) => {
    line = line.trim();
    if (line !== "") {
      try {
        line = new RegExp(line.trim());
        out.push(line);
      } catch (e) {
        console.error(e);
      }
    }
  });
  return out;
}

function matchesRegEx(url) {
  for (let i = 0; i < regexList.length; i++) {
    if (regexList[i].test(url)) {
      return true;
    }
  }
  return false;
}

function onRemoved(tabId) {
  if (wasActive.has(tabId)) {
    wasActive.delete(tabId);
  }
  if (awaitsActivation.has(tabId)) {
    awaitsActivation.delete(tabId);
  }
}

async function onActivated(activeInfo) {
  if (!wasActive.has(activeInfo.tabId)) {
    wasActive.add(activeInfo.tabId);
    const url = awaitsActivation.get(activeInfo.tabId);
    if (url) {
      awaitsActivation.delete(activeInfo.tabId);
      browser.tabs.update(activeInfo.tabId, {
        url,
      });
    }
  }
}

async function onBeforeRequest(e) {
  if (!wasActive.has(e.tabId)) {
    const mre = matchesRegEx(e.url);

    if (
      (mode && mre) || // blacklist(true) => matches are not allowed to load
      (!mode && !mre) // whitelist(false) => matches are allowed to load <=> no match => not allowed
    ) {
      awaitsActivation.set(e.tabId, e.url);
      return { cancel: true };
    }
    wasActive.add(e.tabId);
  }
}

async function onStorageChange() {
  // shutdown

  browser.tabs.onActivated.removeListener(onActivated);
  browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  browser.tabs.onRemoved.removeListener(onRemoved);

  wasActive.clear();
  awaitsActivation.clear();

  browser.browserAction.setBadgeText({ text: "off" });
  browser.browserAction.setBadgeBackgroundColor({
    color: [115, 0, 0, 115],
  });

  // startup

  const manually_disabled = await getFromStorage(
    "boolean",
    "manually_disabled",
    false,
  );

  if (!manually_disabled) {
    mode = await getFromStorage("boolean", "mode", false);
    regexList = await getRegexList();

    for (const tab of await browser.tabs.query({})) {
      wasActive.add(tab.id);
    }
    browser.browserAction.setBadgeText({ text: "on" });
    browser.browserAction.setBadgeBackgroundColor({
      color: [0, 115, 0, 115],
    });

    browser.tabs.onRemoved.addListener(onRemoved);

    browser.tabs.onActivated.addListener(onActivated);
    browser.webRequest.onBeforeRequest.addListener(
      onBeforeRequest,
      { urls: ["<all_urls>"], types: ["main_frame"] },
      ["blocking"],
    );
  }
}

(async () => {
  await onStorageChange();

  browser.browserAction.onClicked.addListener(async () => {
    setToStorage(
      "manually_disabled",
      !(await getFromStorage("boolean", "manually_disabled", false)),
    );
  });

  browser.storage.onChanged.addListener(onStorageChange);
})();
