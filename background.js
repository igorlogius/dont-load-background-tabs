/* global browser */

let wasActive = new Set();
let awaitsActivation = new Map();
let wakeUpAlarmId;
let regexList;
let mode;

// >>> preload
const bodyText = "Loading now, please wait...";
let decoder;
let encoder;
let parser;
// <<<

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

function onMessage(message, sender) {
  if (message.bodyText.startsWith(bodyText)) {
    awaitsActivation.set(sender.tab.id, message.url);
  }
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

async function onBeforeRequestPreload(e) {
  if (!wasActive.has(e.tabId)) {
    const mre = matchesRegEx(e.url);

    if (
      (mode && mre) || // blacklist(true) => matches are not allowed to load
      (!mode && !mre) // whitelist(false) => matches are allowed to load <=> no match => not allowed
    ) {
      const filter = await browser.webRequest.filterResponseData(e.requestId);

      const data = [];
      // just save the chunks
      filter.ondata = (event) => {
        data.push(event.data);
      };

      // lets get creative
      filter.onstop = (event) => {
        let str = "";
        if (data.length === 1) {
          str = decoder.decode(data[0]);
        } else {
          for (let i = 0; i < data.length; i++) {
            const stream = i !== data.length - 1;
            str += decoder.decode(data[i], { stream });
          }
        }

        try {
          const doc = parser.parseFromString(str, "text/html");

          // error handling https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString
          // this error check is pretty useless, ... even if the data is binary image data ... it doenst throws or
          // indicates an error ... oh well, lets leave it for now
          const errorNode = doc.querySelector("parsererror");
          if (errorNode) {
            console.error(errorNode.innerText);
          } else {
            if (doc.body.childElementCount > 1) {
              // parsing succeeded
              if (doc.title) {
                const docTitle = doc.title
                  .split("/[<>\\ ]/") // little bit of sanatizing
                  .join(" ")
                  .replaceAll(/\s+/g, " ");
                // https://validator.w3.org/nu/ => No errors or warnings to show.
                str = `<!DOCTYPE html><html lang="en"><head><title>${docTitle}</title></head><body>${bodyText}</body></html>`;
                filter.write(encoder.encode(str));
                filter.close(); // close filter ... disconnect would allow extra data, which we dont want
                return;
              }
            }
          }
        } catch (e) {
          console.error(e);
        }
        //filter.write(encoder.encode(str));
        for (let i = 0; i < data.length; i++) {
          filter.write(data[i]);
        }
        filter.close(); // close filter ... disconnect would allow extra data, which we dont want
        return;
      };

      // dont add to wasActive here
      return;
    }
    wasActive.add(e.tabId);
  }
}

async function onStorageChange() {
  // shutdown

  clearInterval(wakeUpAlarmId);

  browser.tabs.onActivated.removeListener(onActivated);
  browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  browser.webRequest.onBeforeRequest.removeListener(onBeforeRequestPreload);
  browser.tabs.onRemoved.removeListener(onRemoved);
  browser.runtime.onMessage.removeListener(onMessage);

  wasActive.clear();
  awaitsActivation.clear();

  delete decoder;
  delete encoder;
  delete parser;

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

    const doPreload = await getFromStorage("boolean", "doPreload", false);
    if (!doPreload) {
      browser.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        { urls: ["<all_urls>"], types: ["main_frame"] },
        ["blocking"],
      );
    } else {
      browser.runtime.onMessage.addListener(onMessage);
      decoder = new TextDecoder("utf-8");
      encoder = new TextEncoder();
      parser = new DOMParser();
      browser.webRequest.onBeforeRequest.addListener(
        onBeforeRequestPreload,
        { urls: ["<all_urls>"], types: ["main_frame"] },
        ["blocking"],
      );
    }

    // WORKAROUND: onActivated does not fire for embedded browser
    wakeUpAlarmId = setInterval(async () => {
      for (const tab of await browser.tabs.query({ active: true })) {
        const url = awaitsActivation.get(tab.id);
        if (url) {
          awaitsActivation.delete(tab.id);
          wasActive.add(tab.id);
          browser.tabs.update(tab.id, {
            url,
          });
        }
      }
    }, 15000);
  }
}

(async () => {
  // -------------------------------
  // inital setup
  // -------------------------------

  await onStorageChange();

  browser.browserAction.onClicked.addListener(async () => {
    const manually_disabled = await getFromStorage(
      "boolean",
      "manually_disabled",
      false,
    );
    setToStorage("manually_disabled", !manually_disabled);
  });

  browser.storage.onChanged.addListener(onStorageChange);
})();
