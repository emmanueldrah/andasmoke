/**
 * Dev-only helper: drives headless Chrome over CDP to load the POS with a
 * signed-in session, optionally run a page snippet (e.g. open a modal), and
 * capture a screenshot at an exact window size.
 *
 * node tmp-cdp-shot.mjs --url=... --w=1440 --h=900 --out=... --theme=light \
 *   [--run="js to run after load"] [--wait=2500] [--fullpage]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);

const URL_TARGET = args.url || 'http://127.0.0.1:3000/?tab=pos';
const W = Number(args.w || 1440);
const H = Number(args.h || 900);
const OUT = resolve(args.out || 'tmp-shot.png');
const THEME = args.theme === 'dark' ? 'dark' : 'light';
const RUN = typeof args.run === 'string' ? args.run : null;
const WAIT = Number(args.wait || 2500);
const FULLPAGE = Boolean(args.fullpage);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9331 + Math.floor(Math.random() * 200);
// Keep the throwaway profile OUT of the workspace: Vite watches the project
// tree and dies on Chrome's locked cookie file.
const PROFILE = join(tmpdir(), `pos-cdp-profile-${Date.now()}`);
const rmQuiet = () => { try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 }); } catch {} };
rmQuiet();

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--window-size=${W},${H}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };

  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send(ws, 'Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };

  // 1. Land on the app origin so localStorage can be written, then set the session.
  await send(ws, 'Page.navigate', { url: 'http://127.0.0.1:3000/' });
  // Wait until the document is actually on the origin (about:blank blocks localStorage).
  for (let i = 0; i < 40; i++) {
    const onOrigin = await evalJs("location.href.startsWith('http://127.0.0.1:3000') ? 'yes' : 'no'").catch(() => 'no');
    if (onOrigin === 'yes') break;
    await sleep(250);
  }
  await sleep(1200);

  const login = await fetch('http://127.0.0.1:4310/api/auth?action=admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'audit@andasmoke.local', pin: '246810' }),
  });
  const { token, admin } = await login.json();
  const session = {
    isLoggedIn: true,
    adminId: admin.id,
    adminName: admin.adminName,
    adminRole: admin.adminRole,
    email: admin.email,
    avatar: admin.avatar || null,
  };
  await evalJs(
    `localStorage.setItem('anda_auth_token', ${JSON.stringify(token)});
     localStorage.setItem('anda_admin_session', ${JSON.stringify(JSON.stringify(session))});
     localStorage.setItem('anda_theme_mode', ${JSON.stringify(THEME)});
     'ok'`,
  );

  // 2. Load the real page.
  await send(ws, 'Page.navigate', { url: URL_TARGET });
  await sleep(WAIT);

  // 3. Optional interaction snippet.
  if (RUN) {
    await evalJs(RUN, true);
    await sleep(1200);
  }

  // 4. Screenshot.
  const metrics = await evalJs(
    `JSON.stringify({sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      iw: window.innerWidth, ih: window.innerHeight})`,
  );
  const m = JSON.parse(metrics);
  const shot = await send(ws, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: FULLPAGE,
    ...(FULLPAGE ? { clip: { x: 0, y: 0, width: Math.max(m.sw, m.iw), height: Math.max(m.sh, m.ih), scale: 1 } } : {}),
  });
  mkdirSync(resolve(OUT, '..'), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${OUT} (${W}x${H}, page ${m.sw}x${m.sh}, viewport ${m.iw}x${m.ih})`);
  ws.close();
}

try {
  await main();
} finally {
  chrome.kill();
  await sleep(600);
  rmQuiet();
  // Clear the profile Vite choked on from the earlier run, if still present.
  try { rmSync(resolve('tmp-chrome-profile'), { recursive: true, force: true, maxRetries: 2 }); } catch {}
}
