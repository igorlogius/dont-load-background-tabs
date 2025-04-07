browser.runtime.sendMessage({
  bodyText: document.body.textContent.slice(0, 30),
  url: document.location.href,
});
