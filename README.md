# Orknux for Chrome

Lets your Orknux agents use your own Chrome: open a page, read it, click, type,
press keys, scroll and take a screenshot - signed in as you, in a window of
their own, while you watch.

## Using it

1. Load it: `chrome://extensions`, switch on Developer mode, **Load unpacked**,
   and pick this folder.
2. Click the Orknux button in the toolbar. The side panel opens.
3. Enter your server's address and a **read and write** access token from your
   Orknux profile page, and press **Connect**. Chrome asks once for permission
   to reach that server.
4. On the agent's page, switch on the `browser_*` tools on its Tools list. They
   are off for every agent until somebody does.

Your browser is lent while the panel is open. Close the panel, press
**Disconnect**, or press **Cancel** on Chrome's "is debugging this browser"
bar, and it is lent no longer.

## What an agent can and cannot do

- It works in its own window, its tabs grouped as **Orknux**. A tab it did not
  open is refused, so your own tabs are never read or touched.
- Only conversations that are yours reach it: your chats, tasks you started, and
  agents those asked. A workflow step or a Slack thread has nobody behind it and
  is told so.
- It acts as you. The tools tell the model to ask before it spends money,
  deletes something or sends something in your name, and to treat what a page
  says as the page's and never as your instruction - but a model can be talked
  round by a page, so do not connect it to an agent you would not trust with
  your sign-ins.
- Chrome's own pages and the Web Store cannot be driven.

## How it works

The panel holds a long poll open to `GET /api/browser/next` on your server. An
agent's `browser_*` call is queued there for you; the panel takes it, does it
through `chrome.debugger` (Chrome's debugging protocol), and posts the answer to
`POST /api/browser/answers/{id}`. Nothing listens on your machine, so it works
from wherever you can reach Orknux.

A page is read from Chrome's accessibility tree: each control comes with a ref
like `e42`, which is the element's DOM node id, so a click names the element
rather than a position.

On a server with more than one node, the browser is known only to the node the
panel is asking; an agent running on another finds no browser connected.

## Checking it

```
test/run.sh
```

Runs a real Chromium with the extension loaded (in the Playwright image, since
there is no Node on the development machine) against a stub server, and drives
every action against a test page. The server's half is `BrowserToolsTest`.
