// What each browser_* tool does, through Chrome's own debugging protocol
// (chrome.debugger). Playwright cannot run inside an extension, and
// chrome.debugger is Google's interface for exactly this, so the protocol is
// spoken here directly.
//
// The agent works in a window of its own - its tabs grouped as "Orknux" - and
// never in the person's tabs: a tab it did not open is refused.

import { linesOf, render } from './snapshot.js';

const PROTOCOL = '1.3';
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 400;

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
};

/** A failure worded for the model, which is who reads it. */
class Refused extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Driver {
  constructor({ onUserStop }) {
    this.windowId = null;
    this.groupId = null;
    this.tabs = new Set();
    this.lastTab = null;
    this.attached = new Set();
    this.onUserStop = onUserStop;
    chrome.debugger.onDetach.addListener((source, reason) => {
      this.attached.delete(source.tabId);
      // The person pressed Cancel on Chrome's "is debugging this browser" bar: that is a stop.
      if (reason === 'canceled_by_user' && this.tabs.has(source.tabId)) this.onUserStop?.();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.tabs.delete(tabId);
      this.attached.delete(tabId);
      if (this.lastTab === tabId) this.lastTab = null;
    });
    chrome.windows.onRemoved.addListener((windowId) => {
      if (windowId === this.windowId) {
        this.windowId = null;
        this.groupId = null;
      }
    });
  }

  /** Runs one command; resolves to its result or throws a Refused worded for the model. */
  async run(action, args) {
    const handler = this[`do_${action}`];
    if (typeof handler !== 'function') throw new Refused(`This extension does not know the action "${action}". It may be older than the server.`);
    return handler.call(this, args ?? {});
  }

  async detachAll() {
    for (const tabId of [...this.attached]) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    this.attached.clear();
  }

  // ---- the tools ----

  async do_tabs() {
    const tabs = [];
    for (const id of this.tabs) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab) tabs.push({ tab: tab.id, title: tab.title, url: tab.url, last: tab.id === this.lastTab });
    }
    return { tabs, note: tabs.length ? undefined : 'No tabs open yet; open one with browser_open.' };
  }

  async do_open({ url, tab }) {
    const address = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(address)) throw new Refused('Give a whole address starting with http:// or https://.');
    let id;
    if (tab != null) {
      id = this.ours(tab);
      await chrome.tabs.update(id, { url: address });
    } else if (this.windowId == null || !(await chrome.windows.get(this.windowId).catch(() => null))) {
      const window = await chrome.windows.create({ url: address, focused: false, width: 1280, height: 900 });
      this.windowId = window.id;
      id = window.tabs[0].id;
    } else {
      id = (await chrome.tabs.create({ windowId: this.windowId, url: address, active: true })).id;
    }
    this.tabs.add(id);
    this.lastTab = id;
    await this.group(id);
    await this.loaded(id);
    const opened = await chrome.tabs.get(id);
    return { tab: id, title: opened.title, url: opened.url };
  }

  async do_snapshot({ tab, interactiveOnly, find, maxCharacters }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    const { nodes } = await this.send(id, 'Accessibility.getFullAXTree', {});
    const page = await chrome.tabs.get(id);
    return render({
      title: page.title,
      url: page.url,
      tab: id,
      lines: linesOf(nodes, { interactiveOnly: !!interactiveOnly }),
      find,
      maxCharacters: Number(maxCharacters) || 20_000,
    });
  }

  async do_click({ ref, tab }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    const backendNodeId = this.nodeOf(ref);
    await this.send(id, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
    const box = await this.send(id, 'DOM.getBoxModel', { backendNodeId }).catch(() => null);
    if (box?.model?.content) {
      const q = box.model.content;
      const x = (q[0] + q[2] + q[4] + q[6]) / 4;
      const y = (q[1] + q[3] + q[5] + q[7]) / 4;
      await this.send(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.send(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.send(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else {
      // Nothing drawn to click on - an option in a closed list, say - so it is clicked the way a script would.
      await this.call(id, backendNodeId, 'function() { this.click(); }');
    }
    await this.settled(id);
    const page = await chrome.tabs.get(id);
    return { clicked: ref, tab: id, title: page.title, url: page.url };
  }

  async do_type({ ref, text, append, submit, tab }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    const backendNodeId = this.nodeOf(ref);
    await this.send(id, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
    await this.send(id, 'DOM.focus', { backendNodeId }).catch(() => {
      throw new Refused(`${ref} cannot take the focus, so nothing can be typed into it. Is it a field?`);
    });
    if (!append) {
      await this.call(id, backendNodeId, `function() {
        if ('value' in this) {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (this.isContentEditable) {
          this.textContent = '';
        }
      }`);
    }
    await this.send(id, 'Input.insertText', { text: String(text ?? '') });
    if (submit) await this.key(id, 'Enter');
    await this.settled(id);
    return { typed: ref, submitted: !!submit, tab: id };
  }

  async do_press({ key, tab }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    await this.key(id, String(key ?? ''));
    await this.settled(id);
    return { pressed: key, tab: id };
  }

  async do_scroll({ direction, tab }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    const metrics = await this.send(id, 'Page.getLayoutMetrics', {});
    const view = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const height = view.clientHeight ?? 800;
    const up = String(direction ?? 'down').toLowerCase() === 'up';
    await this.send(id, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: (view.clientWidth ?? 800) / 2,
      y: height / 2,
      deltaX: 0,
      deltaY: (up ? -1 : 1) * Math.round(height * 0.8),
    });
    await sleep(SETTLE_MS);
    const at = await this.send(id, 'Runtime.evaluate', {
      expression: 'JSON.stringify([scrollY, innerHeight, document.documentElement.scrollHeight])',
      returnByValue: true,
    });
    const [y, inner, whole] = JSON.parse(at.result.value);
    return { tab: id, scrolledTo: Math.round(y), pageHeight: whole, atEnd: y + inner >= whole - 2, atTop: y <= 0 };
  }

  async do_back({ tab }) {
    const id = this.tabOf(tab);
    await chrome.tabs.goBack(id).catch(() => {
      throw new Refused('There is no page before this one in the tab.');
    });
    await this.loaded(id);
    const page = await chrome.tabs.get(id);
    return { tab: id, title: page.title, url: page.url };
  }

  async do_screenshot({ tab }) {
    const id = this.tabOf(tab);
    // A tab in the background is not drawn, so it is brought to the front of the agent's own window.
    await chrome.tabs.update(id, { active: true });
    await this.attach(id);
    const shot = await this.send(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    const page = await chrome.tabs.get(id);
    return { data: shot.data, mimeType: 'image/jpeg', tab: id, title: page.title, url: page.url };
  }

  async do_close({ tab }) {
    const id = this.tabOf(tab);
    await chrome.tabs.remove(id);
    return { closed: id };
  }

  // ---- the parts ----

  /** A tab the agent opened; any other is refused, so the person's own tabs are never touched. */
  ours(tab) {
    const id = Number(tab);
    if (!this.tabs.has(id)) throw new Refused(`Tab ${tab} is not one of yours. browser_tabs lists yours; open one with browser_open.`);
    return id;
  }

  tabOf(tab) {
    if (tab != null && tab !== '') return this.ours(tab);
    if (this.lastTab == null || !this.tabs.has(this.lastTab)) throw new Refused('No tab is open yet: open a page with browser_open first.');
    return this.lastTab;
  }

  nodeOf(ref) {
    const match = /^e(\d+)$/.exec(String(ref ?? '').trim());
    if (!match) throw new Refused(`"${ref}" is not a ref. Refs look like e42 and come from browser_snapshot.`);
    return Number(match[1]);
  }

  async group(tabId) {
    try {
      if (this.groupId != null) {
        await chrome.tabs.group({ groupId: this.groupId, tabIds: [tabId] });
      } else {
        this.groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: this.windowId } });
        await chrome.tabGroups.update(this.groupId, { title: 'Orknux', color: 'purple' });
      }
    } catch {
      this.groupId = null;
    }
  }

  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
    } catch (failed) {
      throw new Refused(`This tab cannot be driven: ${failed.message}. Chrome's own pages and the web store are off limits.`);
    }
    this.attached.add(tabId);
    await this.send(tabId, 'DOM.enable', {}).catch(() => {});
    await this.send(tabId, 'Accessibility.enable', {}).catch(() => {});
    await this.send(tabId, 'DOM.getDocument', { depth: 0 }).catch(() => {});
  }

  async send(tabId, method, params) {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (failed) {
      const said = String(failed.message ?? failed);
      if (/No node|Could not find node|does not belong/i.test(said)) {
        throw new Refused('That ref points at nothing on the page now - it changed since the snapshot. Take a fresh browser_snapshot.');
      }
      throw new Refused(`The browser refused ${method}: ${said}`);
    }
  }

  async call(tabId, backendNodeId, fn) {
    const { object } = await this.send(tabId, 'DOM.resolveNode', { backendNodeId });
    await this.send(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn });
  }

  async key(tabId, name) {
    const known = KEYS[name];
    let event;
    if (known) {
      event = { key: known.key ?? name, code: known.code, windowsVirtualKeyCode: known.keyCode, text: known.text };
    } else if ([...name].length === 1) {
      event = { key: name, text: name };
    } else {
      throw new Refused(`"${name}" is not a key this knows. Use Enter, Tab, Escape, an arrow, or one character.`);
    }
    await this.send(tabId, 'Input.dispatchKeyEvent', { type: event.text ? 'keyDown' : 'rawKeyDown', ...event });
    await this.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode });
  }

  /** Waits for a tab to finish loading, or for the timeout. */
  async loaded(tabId) {
    const until = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < until) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Refused('The tab was closed.');
      if (tab.status === 'complete') break;
      await sleep(150);
    }
    await sleep(SETTLE_MS);
  }

  /** After an action: a navigation it started is waited out, and a moment is given for the page to redraw. */
  async settled(tabId) {
    await sleep(SETTLE_MS);
    await this.loaded(tabId);
  }
}

export { Refused };
