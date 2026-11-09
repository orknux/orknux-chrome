# Changelog

Each release's section is its notes, on GitHub, on orknux.ai and in the
Chrome Web Store. Written before the tag: the release workflow refuses a tag
with no section here, and one that is not `manifest.json`'s version.

## 1.0.5

### Added

- Where your agent clicks or types, the page shows it: a ring at the point it
  clicked and an outline round what it clicked or typed into, fading after a
  second and a half. It never takes a click, never moves the page, and is
  taken off before a screenshot the agent asked for. A switch in the side
  panel turns it off.
- Scrolling by an amount, sideways, inside a box of the page that scrolls on
  its own - a list, a side pane - or until an element is in view. It needs an
  Orknux server that knows to ask for it; an older extension asked for it
  says it does not know how, rather than scrolling the wrong thing.

## 1.0.4

The first release built by CI: a zip to load unpacked or to give the Chrome
Web Store.

### Added

- The side panel says the extension's version beside its name.
- Connect with the pairing link Orknux gives under Preferences › Connected
  clients › Connect a client, or with its code - no access token needed.

### Fixed

- Only the extension's own credential is sent to the server, never the
  browser's sign-in to it.
