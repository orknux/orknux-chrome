// The toolbar button opens the side panel, which is where the connection lives:
// the browser is lent to Orknux exactly while the panel is open, so closing it
// is how a person takes it back.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
