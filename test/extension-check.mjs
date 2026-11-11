/**
 * The extension driving a real Chromium, end to end.
 *
 * A stub stands in for the server - the same four endpoints, holding the
 * commands a test sends and the answers the extension posts - so what is
 * proved here is the extension's half: that each browser_* action does to a
 * page what it says, through chrome.debugger, from inside an extension page.
 * The server's half is BrowserToolsTest.
 *
 *   orknux-chrome/test/run.sh
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'orkx_test';
const queue = [];
const waiting = new Map();
const pollers = [];
const paired = [];
let failures = 0;

function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

const PAGE = `<!doctype html><title>Form page</title>
<h1>Welcome</h1><p>Some text about the form.</p>
<label>Name <input id="name" value="old"></label>
<button id="go" onclick="document.getElementById('out').textContent='Hello ' + document.getElementById('name').value">Greet</button>
<p id="out">nobody yet</p>
<input id="enter" aria-label="Search" onkeydown="if(event.key==='Enter'){document.getElementById('out').textContent='searched ' + this.value}">
<a href="/second.html">Second page</a>
<div id="pane" style="height:60px;overflow:auto"><button id="inner">Inside the pane</button><div style="height:400px"></div><button id="deep">Deep in the pane</button></div>
<div style="height:4000px"></div><p>The very end</p>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (url.pathname === '/page.html') return res.end(PAGE);
  if (url.pathname === '/second.html') return res.end('<title>Second</title><p>Second page here</p>');
  if (url.pathname === '/api/client/compatibility') return send(200, { product: 'Orknux', server: '1.3.6', serverMajor: 1, compatible: true, reason: null });
  if (url.pathname === '/api/clients/pair' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const asked = JSON.parse(body);
    paired.push(asked);
    return asked.code.toUpperCase().replace('-', '') === 'K7P4QX' ? send(200, { credential: TOKEN, user: 'alice' }) : send(400, { error: 'That pairing code is not valid.' });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'no' });
  if (url.pathname === '/api/browser/hello') return send(200, { user: 'alice' });
  if (url.pathname === '/api/browser/next') {
    if (queue.length) return send(200, queue.shift());
    const timer = setTimeout(() => {
      pollers.splice(pollers.indexOf(poller), 1);
      send(204);
    }, 2000);
    const poller = (command) => {
      clearTimeout(timer);
      send(200, command);
    };
    pollers.push(poller);
    return;
  }
  const answer = /^\/api\/browser\/answers\/(.+)$/.exec(url.pathname);
  if (answer && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const resolve = waiting.get(answer[1]);
    waiting.delete(answer[1]);
    resolve?.(JSON.parse(body));
    return send(resolve ? 204 : 410);
  }
  send(404, {});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

/**
 * The marks drawn on a page, read the way the agent's own driver could not be
 * fooled into reading them: through the protocol, piercing the closed shadow
 * root, with each ring and box measured where Chrome drew it.
 */
async function marksOn(page) {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const found = { hosts: 0, rings: [], boxes: [] };
    const classOf = (node) => {
      const at = (node.attributes ?? []).indexOf('class');
      return at >= 0 ? node.attributes[at + 1] : '';
    };
    const walk = async (node, inMark) => {
      if (node.nodeName === 'ORKNUX-MARK') found.hosts++;
      const kind = classOf(node);
      if (inMark && node.nodeName === 'DIV' && (kind === 'ring' || kind === 'box')) {
        const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId });
        const q = model.border;
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const rect = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
        (kind === 'ring' ? found.rings : found.boxes).push(rect);
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        await walk(child, inMark || node.nodeName === 'ORKNUX-MARK');
      }
    };
    await walk(root, false);
    return found;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const near = (a, b, by = 2) => Math.abs(a - b) <= by;
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
const centreOf = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const rectIn = (page, selector) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, selector);

let next = 0;
function command(action, args = {}) {
  const id = String(++next);
  const sent = { id, action, arguments: args };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${action} was not answered`)), 30_000);
    waiting.set(id, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    const poller = pollers.shift();
    if (poller) poller(sent);
    else queue.push(sent);
  });
}

// The extension as shipped, plus a host permission for the stub so no permission prompt is drawn.
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'orknux-ext-'));
const SOURCE = process.env.EXT_DIR ?? path.resolve(import.meta.dirname, '..');
fs.cpSync(SOURCE, copy, { recursive: true, filter: (from) => path.relative(SOURCE, from).split(path.sep)[0] !== 'test' });
const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const panel = await context.newPage();
await panel.goto(`chrome-extension://${extensionId}/panel.html`);
{
  const shown = (await panel.textContent('[data-testid="version"]'))?.trim();
  const loaded = await panel.evaluate(() => chrome.runtime.getManifest().version);
  check('the panel says which version it is, beside its name', Boolean(shown) && shown === loaded, `${shown} / ${loaded}`);
}
// The access token is hidden, and Show shows it and Hide hides it again.
{
  await panel.fill('#token', 'orkx_seen');
  const hidden = await panel.getAttribute('#token', 'type');
  await panel.click('#show-token');
  const shown = await panel.getAttribute('#token', 'type');
  const said = (await panel.textContent('#show-token'))?.trim();
  await panel.click('#show-token');
  const again = await panel.getAttribute('#token', 'type');
  const row = await panel.evaluate(() => {
    const field = document.getElementById('token').getBoundingClientRect();
    const button = document.getElementById('show-token').getBoundingClientRect();
    return { sameRow: Math.abs(field.top + field.height / 2 - (button.top + button.height / 2)) <= 1, beside: button.left >= field.right };
  });
  check('the access token is hidden, Show shows it and Hide hides it again',
    hidden === 'password' && shown === 'text' && said === 'Hide' && again === 'password', `${hidden} ${shown} ${said} ${again}`);
  check('and the button sits beside the field, on its line', row.sameRow && row.beside, JSON.stringify(row));
  await panel.fill('#token', '');
}
await panel.fill('#server', BASE);
// A pairing code, as Orknux shows it: traded for the browser's own credential.
await panel.fill('#token', 'k7p-4qx');
await panel.click('#connect');
await panel.waitForFunction(() => document.getElementById('state').textContent.includes('alice'), null, { timeout: 10_000 });
check('a pairing code connects the panel, which says who it is', paired.length === 1 && paired[0].client === 'Chrome', JSON.stringify(paired));
check('and the code is replaced by the credential it was traded for', (await panel.inputValue('#token')) === TOKEN);

try {
  const opened = await command('open', { url: `${BASE}/page.html` });
  check('open loads a page in a tab of its own', opened.result?.title === 'Form page', JSON.stringify(opened));
  const tab = opened.result.tab;

  const snap = (await command('snapshot', { maxCharacters: 20000 })).result;
  check('snapshot names the page and its heading', snap.text.includes('Page: Form page') && snap.text.includes('heading 1 "Welcome"'), snap.text);
  const field = /\[(e\d+)\] textbox "Name"/.exec(snap.text)?.[1];
  const button = /\[(e\d+)\] button "Greet"/.exec(snap.text)?.[1];
  const search = /\[(e\d+)\] textbox "Search"/.exec(snap.text)?.[1];
  check('snapshot gives the controls refs', !!field && !!button && !!search, snap.text);
  check('snapshot shows a field\'s value', /textbox "Name" value="old"/.test(snap.text), snap.text);

  const agentPage = context.pages().find((open) => open.url().endsWith('/page.html'));
  const outBefore = await rectIn(agentPage, '#out');

  await command('type', { ref: field, text: 'Michal' });
  const typed = await marksOn(agentPage);
  const nameRect = await rectIn(agentPage, '#name');
  check('typing outlines the field it typed into', typed.boxes.some((box) => sameRect(box, nameRect)) && typed.rings.length === 0,
    `${JSON.stringify(typed)} / ${JSON.stringify(nameRect)}`);

  await command('click', { ref: button });
  const clicked = await marksOn(agentPage);
  const goRect = await rectIn(agentPage, '#go');
  const ring = clicked.rings[0];
  check('a click draws one ring, centred where it clicked',
    clicked.rings.length === 1 && near(centreOf(ring).x, centreOf(goRect).x) && near(centreOf(ring).y, centreOf(goRect).y),
    `${JSON.stringify(clicked.rings)} / ${JSON.stringify(goRect)}`);
  check('and outlines what it clicked', clicked.boxes.some((box) => sameRect(box, goRect)), JSON.stringify(clicked.boxes));
  const host = await agentPage.evaluate(() => {
    const mark = document.querySelector('orknux-mark');
    if (!mark) return null;
    const style = getComputedStyle(mark);
    return { position: style.position, pointerEvents: style.pointerEvents, hidden: mark.getAttribute('aria-hidden'), open: mark.shadowRoot !== null };
  });
  check('the mark is fixed, takes no pointer, is hidden from a reader and closed to the page',
    host?.position === 'fixed' && host.pointerEvents === 'none' && host.hidden === 'true' && host.open === false, JSON.stringify(host));
  const outAfter = await rectIn(agentPage, '#out');
  check('and the page did not move for it', sameRect(outBefore, outAfter), `${JSON.stringify(outBefore)} / ${JSON.stringify(outAfter)}`);

  const after = (await command('snapshot', { find: 'hello' })).result;
  check('type replaces a field and click presses a button', after.text.includes('Hello Michal'), after.text);

  await agentPage.waitForTimeout(2000);
  check('the marks fade and are taken off the page', (await marksOn(agentPage)).hosts === 0);

  await command('click', { ref: button });
  await command('screenshot');
  check('a screenshot right after a click shows the page without the mark', (await marksOn(agentPage)).hosts === 0);

  await panel.uncheck('#show-actions');
  await command('click', { ref: button });
  check('switched off in the panel, a click draws nothing', (await marksOn(agentPage)).hosts === 0);
  await panel.check('#show-actions');
  await command('click', { ref: button });
  check('and switched on again, it does', (await marksOn(agentPage)).hosts === 1);
  await agentPage.waitForTimeout(2000);

  await command('type', { ref: search, text: 'kicad', submit: true });
  const searched = (await command('snapshot', { find: 'searched' })).result;
  check('submit presses Enter in the field', searched.text.includes('searched kicad'), searched.text);

  const only = (await command('snapshot', { interactiveOnly: true })).result;
  check('interactiveOnly leaves the text out', !only.text.includes('Some text about the form') && only.text.includes('button "Greet"'), only.text);

  const small = (await command('snapshot', { maxCharacters: 120 })).result;
  check('a long page is cut and says so', !!small.cut && small.text.length <= 120, JSON.stringify(small));

  const scrolled = (await command('scroll', { direction: 'down' })).result;
  check('scroll moves down the page', scrolled.scrolledTo > 0, JSON.stringify(scrolled));

  {
    const inner = /\[(e\d+)\] button "Inside the pane"/.exec(snap.text)?.[1];
    const deep = /\[(e\d+)\] button "Deep in the pane"/.exec(snap.text)?.[1];
    const pageY = () => agentPage.evaluate(() => scrollY);
    const paneY = () => agentPage.evaluate(() => document.getElementById('pane').scrollTop);

    const startY = await pageY();
    const by = (await command('scroll_by', { direction: 'down', amount: 100 })).result;
    check('scroll_by moves the page by the amount asked', by.scrolled === 'page' && by.moved === true && by.scrolledTo === startY + 100 && (await pageY()) === startY + 100,
      JSON.stringify(by));

    const before = await pageY();
    const inside = (await command('scroll_by', { direction: 'down', amount: 50, within: inner })).result;
    check('scroll_by within a ref moves the box around it, not the page',
      inside.scrolled === 'box' && inside.moved === true && (await paneY()) === 50 && (await pageY()) === before, JSON.stringify(inside));

    await command('scroll_by', { direction: 'up', amount: 1000, within: inner });
    const stuck = (await command('scroll_by', { direction: 'up', within: inner })).result;
    check('at its end it says it did not move, in words', stuck.moved === false && /did not move/.test(stuck.note ?? ''), JSON.stringify(stuck));

    const sideways = await command('scroll_by', { direction: 'sideways' });
    check('a direction it does not know is refused in words', /not a direction/.test(sideways.error ?? ''), JSON.stringify(sideways));

    const to = (await command('scroll_to', { ref: deep })).result;
    const seen = await agentPage.evaluate(() => {
      const pane = document.getElementById('pane').getBoundingClientRect();
      const it = document.getElementById('deep').getBoundingClientRect();
      return it.top >= pane.top && it.bottom <= pane.bottom + 1 && it.top >= 0 && it.bottom <= innerHeight;
    });
    check('scroll_to brings an element into view, inside the box it sits in', to.moved === true && to.shown === true && to.ref === deep && typeof to.scrolledTo === 'number' && seen, JSON.stringify(to));
    await agentPage.waitForTimeout(1600);
  }

  const shot = (await command('screenshot')).result;
  check('screenshot answers a picture', shot.mimeType === 'image/jpeg' && shot.data.length > 1000, `${shot.data?.length} chars`);

  const link = /\[(e\d+)\] link "Second page"/.exec(snap.text)?.[1];
  const went = (await command('click', { ref: link })).result;
  check('clicking a link waits for the next page', went.title === 'Second', JSON.stringify(went));
  const back = (await command('back')).result;
  check('back returns to the page before', back.title === 'Form page', JSON.stringify(back));

  const stale = await command('click', { ref: 'e999999' });
  check('a ref that points at nothing is refused in words', /fresh browser_snapshot|nothing/.test(stale.error ?? ''), JSON.stringify(stale));

  const theirs = await command('click', { ref: field, tab: 123456 });
  check('a tab it did not open is refused', /not one of yours/.test(theirs.error ?? ''), JSON.stringify(theirs));

  const tabs = (await command('tabs')).result;
  check('tabs lists its own tab', tabs.tabs.length === 1 && tabs.tabs[0].tab === tab, JSON.stringify(tabs));

  const unknown = await command('fly', {});
  check('an unknown action is refused in words', /does not know the action/.test(unknown.error ?? ''), JSON.stringify(unknown));

  await command('close', { tab });
  const none = (await command('tabs')).result;
  check('close closes it', none.tabs.length === 0, JSON.stringify(none));

  const log = await panel.locator('#log li').allTextContents();
  check('the panel logs what was done', log.some((line) => line.includes('Clicked')), log.slice(0, 3).join(' | '));

  // A pairing link alone, pasted into the server field: split into the server and the code, and traded.
  await panel.click('#disconnect');
  await panel.waitForFunction(() => document.getElementById('state').textContent.includes('Not connected'), null, { timeout: 10_000 });
  await panel.fill('#server', `${BASE}/pair/k7p4qx`);
  await panel.fill('#token', '');
  await panel.click('#connect');
  await panel.waitForFunction(() => document.getElementById('state').textContent.includes('alice'), null, { timeout: 10_000 });
  check('a pairing link alone connects the panel', paired.length === 2, JSON.stringify(paired));
  check('and is split into the server and the credential', (await panel.inputValue('#server')) === BASE && (await panel.inputValue('#token')) === TOKEN,
    `${await panel.inputValue('#server')} / ${(await panel.inputValue('#token')).slice(0, 6)}`);
} catch (failed) {
  check('the run finished', false, failed.message);
}

await context.close();
server.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
