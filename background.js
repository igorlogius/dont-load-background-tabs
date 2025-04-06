/* global browser */

let manually_disabled = false;
let wasActive = new Set();
let awaitsActivation = new Map();
let doPreload = false;

let decoder = new TextDecoder("utf-8");
let encoder = new TextEncoder();
let parser = new DOMParser();

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

async function onStorageChange() {
  doPreload = await getFromStorage("boolean", "doPreload", doPreload);
  manually_disabled = await getFromStorage(
    "boolean",
    "manually_disabled",
    manually_disabled,
  );
  if (manually_disabled) {
    browser.browserAction.setBadgeText({ text: "off" });
    browser.browserAction.setBadgeBackgroundColor({
      color: [115, 0, 0, 115],
    });
  } else {
    browser.browserAction.setBadgeText({ text: "on" });
    browser.browserAction.setBadgeBackgroundColor({
      color: [0, 115, 0, 115],
    });
  }
  mode = await getFromStorage("boolean", "mode", false);
  regexList = await getRegexList();
}

(async () => {
  // -------------------------------
  // inital setup
  // -------------------------------
  for (const atab of await browser.tabs.query({ active: true })) {
    wasActive.add(atab.id);
  }

  await onStorageChange();

  // -------------------------------
  // register listeners
  // -------------------------------

  browser.tabs.onRemoved.addListener((tabId) => {
    if (wasActive.has(tabId)) {
      wasActive.delete(tabId);
    }
    if (awaitsActivation.has(tabId)) {
      awaitsActivation.delete(tabId);
    }
  });

  browser.browserAction.onClicked.addListener(() => {
    manually_disabled = !manually_disabled;
    setToStorage("manually_disabled", manually_disabled);
  });

  browser.storage.onChanged.addListener(onStorageChange);

  browser.webRequest.onBeforeRequest.addListener(
    async (e) => {
      if (!manually_disabled) {
        if (!wasActive.has(e.tabId)) {
          const reqTab = await browser.tabs.get(e.tabId);
          if (!reqTab.active) {
            const mre = matchesRegEx(e.url);

            if (
              (mode && mre) || // blacklist(true) => matches are not allowed to load
              (!mode && !mre) // whitelist(false) => matches are allowed to load <=> no match => not allowed
            ) {
              if (!doPreload) {
                awaitsActivation.set(e.tabId, { url: e.url, ready: true });
                return { cancel: true };
              } else {
                awaitsActivation.set(e.tabId, { url: e.url, ready: false });
                let filter = await browser.webRequest.filterResponseData(
                  e.requestId,
                );

                filter.ondata = (event) => {
                  let str = decoder.decode(event.data, { stream: true });
                  const doc = parser.parseFromString(str, "text/html");
                  const docTitle = doc.title
                    .split("/[<>\\ ]/") // little bit of sanatizing
                    .join(" ")
                    .replaceAll(/\s+/g, " ");
                  // https://validator.w3.org/nu/ => No errors or warnings to show.
                  str = `<!DOCTYPE html><html lang="en"><head><title>${docTitle}</title></head><body><h1>Loading now, please wait...</h1></body></html>`;
                  filter.write(encoder.encode(str));
                  filter.close(); // close filter ... disconnect would allow extra data, which we dont want
                };
                // dont add to wasActive here
                return;
              }
            }
          }
          // not really, but lets treat it like it has been activated
          wasActive.add(e.tabId);
        }
      }
    },
    {
      urls: ["<all_urls>"],
      types: ["main_frame"],
    },
    ["blocking"],
  );

  // ----

  // handle activated AFTER dummy page ready
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    if (!wasActive.has(activeInfo.tabId)) {
      wasActive.add(activeInfo.tabId);
      if (awaitsActivation.has(activeInfo.tabId)) {
        if (awaitsActivation.get(activeInfo.tabId).ready === true) {
          browser.tabs.update(activeInfo.tabId, {
            url: awaitsActivation.get(activeInfo.tabId).url,
          });
          awaitsActivation.delete(activeInfo.tabId);
        }
      }
    }
  });

  // handle activated BEFORE dummy page ready
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message === "ready") {
      if (awaitsActivation.has(sender.tab.id)) {
        awaitsActivation.get(sender.tab.id).ready = true;
        if (wasActive.has(sender.tab.id)) {
          browser.tabs.update(sender.tab.id, {
            url: awaitsActivation.get(sender.tab.id).url,
          });
          awaitsActivation.delete(sender.tab.id);
        }
      } /* else -> should not happend <- !!
        // - or the dummy page detection failed and we got a message from a none dummy tab => could happend ... then lets just ignore it
        // - either the page rendered faster then onBeforeRequest => should never happend with BLOCKINGREQUEST if it does ... DRAGONS !
        */
    }
  });

  /*
  // debug
  setInterval(() => {
        console.debug('wasActive', wasActive);
        console.debug('awaitsActivation', awaitsActivation);
    },5000);
  */
})();
