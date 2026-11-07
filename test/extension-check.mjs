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

  await command('type', { ref: field, text: 'Michal' });
  await command('click', { ref: button });
  const after = (await command('snapshot', { find: 'hello' })).result;
  check('type replaces a field and click presses a button', after.text.includes('Hello Michal'), after.text);

  await command('type', { ref: search, text: 'kicad', submit: true });
  const searched = (await command('snapshot', { find: 'searched' })).result;
  check('submit presses Enter in the field', searched.text.includes('searched kicad'), searched.text);

  const only = (await command('snapshot', { interactiveOnly: true })).result;
  check('interactiveOnly leaves the text out', !only.text.includes('Some text about the form') && only.text.includes('button "Greet"'), only.text);

  const small = (await command('snapshot', { maxCharacters: 120 })).result;
  check('a long page is cut and says so', !!small.cut && small.text.length <= 120, JSON.stringify(small));

  const scrolled = (await command('scroll', { direction: 'down' })).result;
  check('scroll moves down the page', scrolled.scrolledTo > 0, JSON.stringify(scrolled));

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
