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
// How long a mark stays on the page: long enough to be seen from across the
// room, short enough that two clicks in a row do not pile up.
const MARK_MS = 1500;
// The world the marks are drawn from. Isolated, so a page that has replaced
// document.createElement or attachShadow cannot stop a mark or reach into it.
const MARK_WORLD = 'orknux-marks';

/**
 * Draws where the agent acted: a ring at the point it clicked and an outline
 * round the element, fading out and then removed. Run in the page, so it is
 * written as source and handed over whole.
 *
 * It must not change the page. The host is fixed-position over the viewport,
 * so nothing reflows; it takes no pointer events, so it can never catch the
 * next click; it is aria-hidden, so a snapshot does not read it; and what it
 * draws sits in a closed shadow root, so the page's CSS cannot restyle it and
 * its own CSS cannot reach the page. Its own inline styles are !important, as
 * the one way to beat a page rule that names the host's tag.
 */
const MARK_SOURCE = `(function (mark) {
  const host = document.createElement('orknux-mark');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important;'
    + ' pointer-events: none !important; z-index: 2147483647 !important; contain: strict !important;'
    + ' display: block !important;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    '.box, .ring { position: absolute; box-sizing: border-box; pointer-events: none; }',
    '.box { border: 2px solid #7b8cde; border-radius: 4px; background: rgba(123, 140, 222, .12);',
    '  animation: fade ' + mark.ms + 'ms ease-out forwards; }',
    '.ring { width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%;',
    '  border: 3px solid #7b8cde; background: rgba(123, 140, 222, .35);',
    '  animation: ring ' + mark.ms + 'ms ease-out forwards; }',
    '@keyframes fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }',
    '@keyframes ring { 0% { transform: scale(.4); opacity: 1; } 60% { transform: scale(1.4); opacity: .9; }',
    '  100% { transform: scale(1.8); opacity: 0; } }',
  ].join(' ');
  root.append(style);
  if (mark.rect) {
    const box = document.createElement('div');
    box.className = 'box';
    box.style.left = mark.rect.x + 'px';
    box.style.top = mark.rect.y + 'px';
    box.style.width = mark.rect.width + 'px';
    box.style.height = mark.rect.height + 'px';
    root.append(box);
  }
  if (mark.point) {
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.left = mark.point.x + 'px';
    ring.style.top = mark.point.y + 'px';
    root.append(ring);
  }
  document.documentElement.append(host);
  setTimeout(() => host.remove(), mark.ms);
})`;

/** Takes every mark off the page at once, before a screenshot. */
const UNMARK_SOURCE = `document.querySelectorAll('orknux-mark').forEach((mark) => mark.remove())`;

/** A quad from DOM.getBoxModel as a rectangle in viewport pixels. */
function rectOf(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

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
  constructor({ onUserStop, showActions = true }) {
    /** Whether a click or a typing is marked on the page; the panel's switch, on unless turned off. */
    this.showActions = showActions;
    /** The isolated world marks are drawn from, per tab, and the document it was made in. */
    this.worlds = new Map();
    this.windowId = null;
    this.groupId = null;
    this.tabs = new Set();
    this.lastTab = null;
    this.attached = new Set();
    this.onUserStop = onUserStop;
    chrome.debugger.onDetach.addListener((source, reason) => {
      this.attached.delete(source.tabId);
      this.worlds.delete(source.tabId);
      // The person pressed Cancel on Chrome's "is debugging this browser" bar: that is a stop.
      if (reason === 'canceled_by_user' && this.tabs.has(source.tabId)) this.onUserStop?.();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.tabs.delete(tabId);
      this.attached.delete(tabId);
      this.worlds.delete(tabId);
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
      // After the click, never before: the mark is for whoever watches, and must not be what was clicked.
      await this.mark(id, { point: { x, y }, rect: rectOf(box.model.border) });
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
    const field = await this.send(id, 'DOM.getBoxModel', { backendNodeId }).catch(() => null);
    if (field?.model?.border) await this.mark(id, { rect: rectOf(field.model.border) });
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

  /**
   * Scrolls by a given amount, either way and either axis, the page or inside
   * a box of its own - a list, a side pane, a table. `within` is any ref in or
   * on that box, because a snapshot gives refs to controls and not to the plain
   * box around them: the nearest box that scrolls that way is the one moved.
   * Behind browser_scroll with an amount, a direction across, or `within`; the
   * plain call stays `scroll`, which every extension knows.
   */
  async do_scroll_by({ direction, amount, within, tab }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    const way = String(direction ?? 'down').toLowerCase();
    if (!['up', 'down', 'left', 'right'].includes(way)) throw new Refused(`"${direction}" is not a direction: say up, down, left or right.`);
    const across = way === 'left' || way === 'right';
    const sign = way === 'up' || way === 'left' ? -1 : 1;
    const by = amount == null || amount === '' ? null : Number(amount);
    if (by != null && !(by > 0)) throw new Refused('amount is a number of pixels above nought; leave it out for most of a screen.');
    const scroll = `function(across, sign, by) {
      // The nearest box at or around this that scrolls that way; the page where none does.
      const scrolls = (el) => {
        const style = getComputedStyle(el);
        const overflow = across ? style.overflowX : style.overflowY;
        const more = across ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight;
        return more && /(auto|scroll|overlay)/.test(overflow);
      };
      let found = this instanceof Element ? this : null;
      while (found && found !== document.body && found !== document.documentElement && !scrolls(found)) found = found.parentElement;
      const page = !found || found === document.body || found === document.documentElement;
      const box = page ? document.scrollingElement || document.documentElement : found;
      const view = page ? (across ? innerWidth : innerHeight) : (across ? box.clientWidth : box.clientHeight);
      const step = sign * (by == null ? Math.round(view * 0.8) : by);
      const before = [box.scrollLeft, box.scrollTop];
      box.scrollBy({ left: across ? step : 0, top: across ? 0 : step, behavior: 'instant' });
      return {
        scrolledTo: Math.round(box.scrollTop), scrolledLeft: Math.round(box.scrollLeft),
        scrolled: page ? 'page' : 'box',
        moved: box.scrollLeft !== before[0] || box.scrollTop !== before[1],
        height: box.scrollHeight, width: box.scrollWidth,
        atTop: box.scrollTop <= 0, atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
        atLeft: box.scrollLeft <= 0, atRight: box.scrollLeft + box.clientWidth >= box.scrollWidth - 2,
      };
    }`;
    const args = [{ value: across }, { value: sign }, { value: by }];
    let objectId;
    if (within != null && within !== '') {
      const backendNodeId = this.nodeOf(within);
      ({ object: { objectId } } = await this.send(id, 'DOM.resolveNode', { backendNodeId }));
      const box = await this.send(id, 'DOM.getBoxModel', { backendNodeId }).catch(() => null);
      if (box?.model?.border) await this.mark(id, { rect: rectOf(box.model.border) });
    } else {
      ({ result: { objectId } } = await this.send(id, 'Runtime.evaluate', { expression: 'document' }));
    }
    const { result, exceptionDetails } = await this.send(id, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration: scroll, arguments: args, returnByValue: true,
    });
    if (exceptionDetails) throw new Refused(`The page refused the scroll: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    await sleep(SETTLE_MS);
    const answer = { tab: id, ...result.value };
    if (within) answer.within = within;
    if (!answer.moved) answer.note = `The ${answer.scrolled === 'box' ? 'box around ' + within : 'page'} did not move: it is at its end that way${answer.scrolled === 'page' && within ? ', and nothing around ' + within + ' scrolls on its own' : ''}.`;
    return answer;
  }

  /** Scrolls until an element is in the middle of the view: the page, and any box it sits in. */
  async do_scroll_to({ ref, tab }) {
    const id = this.tabOf(tab);
    await this.attach(id);
    const backendNodeId = this.nodeOf(ref);
    // Where it was drawn before and after: it moved if the page, or any box it sits in, scrolled.
    const before = await this.send(id, 'DOM.getBoxModel', { backendNodeId }).catch(() => null);
    await this.call(id, backendNodeId, "function() { this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }");
    await sleep(SETTLE_MS);
    const box = await this.send(id, 'DOM.getBoxModel', { backendNodeId }).catch(() => null);
    if (box?.model?.border) await this.mark(id, { rect: rectOf(box.model.border) });
    const y = (await this.send(id, 'Runtime.evaluate', { expression: 'scrollY', returnByValue: true })).result.value;
    const moved = JSON.stringify(before?.model?.border ?? null) !== JSON.stringify(box?.model?.border ?? null);
    const answer = { tab: id, ref, scrolledTo: Math.round(y), moved, shown: !!box?.model };
    if (!box?.model) answer.note = `${ref} is not drawn - hidden, or in a closed part of the page - so there was nothing to bring into view.`;
    return answer;
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
    // The marks are for a person watching; the agent asked for the page, so it gets the page.
    await this.unmark(id);
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

  /**
   * Draws a mark where the agent acted. Never fails the action it marks: a
   * page that cannot be drawn on - a PDF, a page mid-navigation - is simply
   * not marked.
   */
  async mark(tabId, { point, rect }) {
    if (!this.showActions) return;
    try {
      const contextId = await this.markWorld(tabId);
      const mark = JSON.stringify({ point, rect, ms: MARK_MS });
      const drawn = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: `${MARK_SOURCE}(${mark})`, contextId });
      // A script that throws in the page answers with the exception rather than failing the call.
      if (drawn?.exceptionDetails) throw new Error(drawn.exceptionDetails.exception?.description ?? 'the mark could not be drawn');
    } catch {
      // Not marked; and the world is made again next time, in case it was what failed.
      this.worlds.delete(tabId);
    }
  }

  async unmark(tabId) {
    try {
      const contextId = await this.markWorld(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: UNMARK_SOURCE, contextId });
    } catch {
      // Nothing to take off.
    }
  }

  /**
   * An isolated world in the tab's top frame. Kept per document - a navigation
   * throws the world away with the page, and the loader id says when one did -
   * so a long session on one page does not make a world per click.
   */
  async markWorld(tabId) {
    const { frameTree } = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {});
    const document = `${frameTree.frame.id}/${frameTree.frame.loaderId}`;
    const held = this.worlds.get(tabId);
    if (held?.document === document) return held.contextId;
    const { executionContextId } = await chrome.debugger.sendCommand({ tabId }, 'Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: MARK_WORLD,
    });
    this.worlds.set(tabId, { document, contextId: executionContextId });
    return executionContextId;
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
