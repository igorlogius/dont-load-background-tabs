if (document.body.textContent === "Loading now, please wait...") {
  browser.runtime.sendMessage("ready");
}
