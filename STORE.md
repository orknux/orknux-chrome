# The Chrome Web Store listing

What to paste into the developer dashboard, and how the release workflow
reaches the store.

## Once, by hand

1. Register at https://chrome.google.com/webstore/devconsole: a Google account
   with two-step verification, and a one-time $5 fee.
2. **New item**: upload the zip from the newest GitHub release
   (`orknux-chrome-<version>.zip`).
3. Fill in the listing below, the privacy tab and the permission
   justifications, and submit. Choose **Unlisted** visibility first: installable
   from its link, not found by searching, while it is new.
4. Note the item's ID (32 letters, in the dashboard's address) for the workflow.

## Listing

**Name:** Orknux

**Summary** (132 characters at most):
Let your Orknux agents use your own Chrome - open pages, read them, click and type - in a window of their own, while you watch.

**Category:** Workflow & Planning

**Description:**

Orknux runs AI agents for you and your team. This extension lends them your
own Chrome, so an agent can do the steps on a website that you would otherwise
do by hand: open a page, read it, click, type, press keys, scroll, and take a
screenshot - signed in as you.

- It works in a window of its own, its tabs grouped as "Orknux". Your own tabs
  are never read or touched.
- Only your own conversations reach it: your chats, tasks you started, and the
  agents those asked.
- You see everything it does, and closing the side panel takes your browser
  back at once.

You need an Orknux server: your own, or your organisation's. In Orknux open
Preferences › Connected clients › Connect a client, and paste the pairing link
into the extension's side panel.

**Images:** the 128×128 icon is `icons/icon-128.png`. At least one screenshot,
1280×800: the side panel connected, beside a page an agent is working on. A
small promo tile, 440×280: the Orknux mark on the dark background.

## Privacy tab

**Single purpose:** Lets the person's own Orknux agents operate web pages in
this browser, in a window of their own, at the person's request.

**Permission justifications:**

- `debugger` - How the agent operates a page: it reads the page's accessibility
  tree, clicks, types, scrolls and takes screenshots through Chrome's debugging
  protocol, on tabs it opened itself in its own window. Chrome shows its
  "is debugging this browser" bar while this is so, and Cancel there stops it.
- `tabs` - To open the pages the agent is asked to visit, and to tell the
  agent's own tabs from the person's, which are refused.
- `tabGroups` - To keep the agent's tabs together in a group named "Orknux", so
  the person sees which tabs the agent is using.
- `storage` - To remember the Orknux server's address and the extension's own
  credential for it between starts.
- `sidePanel` - The side panel is where the person connects, sees what the
  agent did, and disconnects.

**Remote code:** No. All of the extension's code is in the package.

**Data usage:** Website content (the pages the agent works on, sent to the
person's own Orknux server at the agent's request); authentication information
(the extension's own credential for that server). Not sold, not used for
anything but the extension's single purpose, not used for creditworthiness or
lending.

**Privacy policy URL:** https://github.com/orknux/orknux-chrome/blob/main/PRIVACY.md

## Automatic uploads

The release workflow uploads each tagged version and submits it for review
when four repository secrets are set:

- `CWS_EXTENSION_ID` - the item's ID from the dashboard.
- `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` - an OAuth client of type *Desktop app*
  in a Google Cloud project with the **Chrome Web Store API** enabled.
- `CWS_REFRESH_TOKEN` - from that client, for the account that owns the item,
  with the scope `https://www.googleapis.com/auth/chromewebstore`.

Without them the workflow still makes the GitHub release and says it did not
upload.
