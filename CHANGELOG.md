# Changelog

Each release's section is its notes, on GitHub, on orknux.ai and in the
Chrome Web Store. Written before the tag: the release workflow refuses a tag
with no section here, and one that is not `manifest.json`'s version.

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
