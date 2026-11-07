// The connection: while this panel is open, ask the server for work, do it,
// post the answer, ask again. Long polling over ordinary authenticated
// requests, so nothing has to listen on this machine and any network that
// lets the person reach Orknux lets this reach it too.

import { Driver } from './driver.js';

const VERSION = chrome.runtime.getManifest().version;
// Said where the name is, so whoever is asked which version they run can read it off the panel.
document.getElementById('version').textContent = VERSION;
const WAIT_SECONDS = 25;
const RETRY_MS = 3_000;
const LOG_LENGTH = 100;

const $ = (id) => document.getElementById(id);

let running = false;
let controller = null;
const driver = new Driver({ onUserStop: () => stop('You cancelled the debugging bar, so the browser was disconnected.') });

function setState(text, kind) {
  $('state').textContent = text;
  $('state').className = 'state ' + kind;
}

function say(text) {
  $('message').hidden = !text;
  $('message').textContent = text ?? '';
}

function log(text, failed = false) {
  const item = document.createElement('li');
  if (failed) item.className = 'failed';
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, text);
  $('log').prepend(item);
  while ($('log').children.length > LOG_LENGTH) $('log').lastChild.remove();
}

function describe(action, args) {
  switch (action) {
    case 'open': return `Opened ${args.url}`;
    case 'click': return `Clicked ${args.ref}`;
    case 'type': return `Typed into ${args.ref}${args.submit ? ' and pressed Enter' : ''}`;
    case 'press': return `Pressed ${args.key}`;
    case 'snapshot': return 'Read the page';
    case 'screenshot': return 'Took a screenshot';
    case 'scroll': return `Scrolled ${args.direction ?? 'down'}`;
    case 'back': return 'Went back';
    case 'close': return 'Closed a tab';
    case 'tabs': return 'Listed its tabs';
    default: return action;
  }
}

function serverOf() {
  return $('server').value.trim().replace(/\/+$/, '');
}

async function request(path, init = {}) {
  const token = $('token').value.trim();
  return fetch(serverOf() + path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    // Its own credential and nothing else: Chrome would otherwise send the
    // browser's Orknux sign-in along, and act as whoever is signed in there.
    credentials: 'omit',
    signal: controller?.signal,
  });
}

/** A pairing code as shown in Orknux, K7P-4QX: any case, with or without its dash. */
const PAIRING_CODE = /^\s*[A-HJ-NP-Za-hj-np-z2-9]{3}-?[A-HJ-NP-Za-hj-np-z2-9]{3}\s*$/;

/**
 * A pairing link, which Connect a client shows: the server and a code in one
 * thing to copy - https://orknux.example.com/pair/K7P-4QX. Everything before
 * the last /pair/ is the server, so one under a path prefix works too.
 */
const PAIRING_LINK = /^\s*(https?:\/\/.+)\/pair\/([A-HJ-NP-Za-hj-np-z2-9]{3}-?[A-HJ-NP-Za-hj-np-z2-9]{3})\/?\s*$/;

/** Splits a pairing link pasted into either field into the server and the code; leaves anything else as it is. */
function splitPairingLink() {
  for (const field of ['server', 'token']) {
    const link = PAIRING_LINK.exec($(field).value);
    if (link !== null) {
      $('server').value = link[1];
      $('token').value = link[2];
      return;
    }
  }
}

/**
 * Trades a pairing code for this browser's own credential, which then stands
 * in the token field and in storage. A code works once and for minutes, so it
 * is never kept.
 */
async function pairWith(server, code) {
  const answer = await fetch(`${server}/api/clients/pair`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), client: 'Chrome', name: `Chrome on ${navigator.userAgentData?.platform ?? navigator.platform ?? 'this computer'}` }),
  });
  const said = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(said.error ?? `The server answered ${answer.status} to the pairing code.`);
  return said.credential;
}

async function connect() {
  say(null);
  splitPairingLink();
  const server = serverOf();
  let origin;
  try {
    origin = new URL(server).origin;
  } catch {
    say('That is not a server address.');
    return;
  }
  // Only this one server, asked for when it is chosen rather than every site at install.
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false);
  if (!granted) {
    say('The extension needs permission to reach your server.');
    return;
  }
  if ($('token').value.trim() === '') {
    say('Paste the pairing link from Orknux, or a server address and an access token.');
    return;
  }
  if (PAIRING_CODE.test($('token').value)) {
    try {
      $('token').value = await pairWith(server, $('token').value);
    } catch (failed) {
      say(failed.message);
      return;
    }
  }
  await chrome.storage.local.set({ server, token: $('token').value.trim() });

  controller = new AbortController();
  setState('Connecting…', 'busy');
  try {
    const compatible = await fetch(`${server}/api/client/compatibility?client=${encodeURIComponent(VERSION)}`).then((r) => r.json());
    if (compatible && compatible.compatible === false) {
      setState('Not connected', 'off');
      say(compatible.reason ?? 'This server and this extension do not work together.');
      return;
    }
    const hello = await request('/api/browser/hello');
    if (hello.status === 401) throw new Error('The server refused the token. Check it, or make a new one.');
    if (!hello.ok) throw new Error(`The server answered ${hello.status}. Is it Orknux, and new enough to have browsers?`);
    const { user } = await hello.json();
    running = true;
    showConnected(true);
    setState(`Connected as ${user}`, 'on');
    log(`Connected to ${origin} as ${user}`);
    loop();
  } catch (failed) {
    setState('Not connected', 'off');
    say(failed.message);
  }
}

async function loop() {
  while (running) {
    let response;
    try {
      response = await request(`/api/browser/next?wait=${WAIT_SECONDS}&client=Chrome&version=${encodeURIComponent(VERSION)}`);
    } catch (failed) {
      if (!running) return;
      setState('Reconnecting…', 'busy');
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      continue;
    }
    if (response.status === 401) {
      stop('The server no longer accepts the token.');
      return;
    }
    if (response.status === 204) {
      if ($('state').classList.contains('busy')) setState('Connected', 'on');
      continue;
    }
    if (!response.ok) {
      setState('Reconnecting…', 'busy');
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      continue;
    }
    setState('Connected', 'on');
    const command = await response.json();
    await perform(command);
  }
}

async function perform({ id, action, arguments: args }) {
  let body;
  try {
    const result = await driver.run(action, args);
    body = { result };
    log(describe(action, args ?? {}));
  } catch (failed) {
    body = { error: failed.message || String(failed) };
    log(`${describe(action, args ?? {})} - ${body.error}`, true);
  }
  const posted = await request(`/api/browser/answers/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (posted?.status === 410) log('The agent had stopped waiting for that answer.', true);
}

function stop(reason) {
  running = false;
  controller?.abort();
  controller = null;
  driver.detachAll();
  showConnected(false);
  setState('Not connected', 'off');
  if (reason) say(reason);
  log('Disconnected');
}

function showConnected(on) {
  $('connect').hidden = on;
  $('disconnect').hidden = !on;
  $('server').disabled = on;
  $('token').disabled = on;
}

$('settings').addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});
$('disconnect').addEventListener('click', () => stop());

chrome.storage.local.get(['server', 'token']).then(({ server, token }) => {
  if (server) $('server').value = server;
  if (token) $('token').value = token;
});

// Closing the panel ends the page and with it the loop; the debugger is let go of as it goes.
window.addEventListener('pagehide', () => driver.detachAll());
