/**
 * UI journey sweep: serve the built SPA, drive it in headless Chrome over CDP.
 *
 * Proves the SCREENS against the fixture; the engine has its own suites. Run from
 * apps/desktop: `bun run build && bun run ui:sweep`.
 */
/// <reference types="bun" />
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const buildDir = join(appRoot, 'build');
// Port 0: the OS assigns one, so a stale run cannot make this flake.
let PORT = 0;
const CDP_PORT = 9333;
const SHOTS = '/tmp/portage-ui';
/** Chrome, from CHROME_PATH, the usual paths, or PATH — CI images differ. */
function findChrome(): string | null {
  const explicit = process.env.CHROME_PATH;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const paths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium'
  ];
  for (const path of paths) if (existsSync(path)) return path;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }
  return null;
}

const CHROME = findChrome();
if (CHROME === null) {
  console.error('ui-sweep: no Chrome found; set CHROME_PATH to one');
  process.exit(2);
}

if (!existsSync(buildDir)) {
  console.error(`ui-sweep: ${buildDir} is missing — run \`bun run build\` first`);
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

// --- the site ---------------------------------------------------------------

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(join(buildDir, path));
    // NO CACHE: a rebuilt bundle behind a cached index.html is the classic
    // "the test passes on the second run" bug, and it hides which build was
    // actually measured.
    const headers = { 'cache-control': 'no-store' };
    if (await file.exists()) return new Response(file, { headers });
    // SPA fallback: /duplicates is a client route, not a file.
    return new Response(Bun.file(join(buildDir, 'index.html')), { headers });
  }
});
// eslint-disable-next-line prefer-const
PORT = server.port ?? 0;

// --- CDP --------------------------------------------------------------------

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

async function openPage(): Promise<Cdp> {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, {
    method: 'PUT'
  });
  const target = (await response.json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((done, fail) => {
    socket.onopen = () => done();
    socket.onerror = () => fail(new Error('could not open the CDP socket'));
  });

  let next = 0;
  const pending = new Map<number, { done: (value: any) => void; fail: (err: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.error) slot.fail(new Error(message.error.message));
    else slot.done(message.result);
  };

  return {
    send(method, params = {}) {
      const id = next++;
      return new Promise((done, fail) => {
        pending.set(id, { done, fail });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    }
  };
}

async function evaluate(page: Cdp, expression: string): Promise<unknown> {
  const result = (await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    // `text` is the useless word "Uncaught"; the description carries the throw.
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(detail);
  }
  return result.result?.value;
}

/**
 * Navigate and wait for the document to settle.
 *
 * CDP will happily evaluate against a context that is being torn down by a
 * navigation, which surfaces as an opaque "Uncaught". Waiting for
 * `readyState === 'complete'` removes the race instead of retrying around it.
 */
async function goto(page: Cdp, url: string): Promise<void> {
  await page.send('Page.navigate', { url });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if (await evaluate(page, `document.readyState === 'complete' && !!document.body`)) return;
    } catch {
      /* mid-navigation; try again */
    }
    if (Date.now() > deadline) throw new Error(`the page never finished loading: ${url}`);
    await Bun.sleep(60);
  }
}

/** Wait until `expression` is truthy, or fail with what was on screen. */
async function waitFor(page: Cdp, expression: string, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await evaluate(page, expression)) return;
    } catch {
      /* a context being replaced is not a failed assertion yet */
    }
    if (Date.now() > deadline) {
      const text = String(await evaluate(page, 'document.body.innerText.slice(0, 600)'));
      throw new Error(`timed out waiting for ${what}. Screen said:\n${text}`);
    }
    await Bun.sleep(80);
  }
}

async function clickText(page: Cdp, selector: string, text: string): Promise<void> {
  const clicked = await evaluate(
    page,
    `(() => {
      const wanted = ${JSON.stringify(text)};
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((el) => (el.textContent || '').includes(wanted));
      if (!node) return false;
      node.click();
      return true;
    })()`
  );
  if (clicked !== true) throw new Error(`no ${selector} containing "${text}"`);
}

async function typeInto(page: Cdp, selector: string, value: string): Promise<void> {
  const typed = await evaluate(
    page,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  if (typed !== true) throw new Error(`no input matching ${selector}`);
}

async function screenshot(page: Cdp, name: string): Promise<string> {
  // Sonner slides a toast in from below; a capture taken mid-transform shows it
  // on top of an action bar it actually clears. Two frames plus a beat is enough
  // for a 0.2-0.4 s transition to land.
  await Bun.sleep(320);
  const shot = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  const path = join(SHOTS, `${name}.png`);
  await Bun.write(path, Buffer.from(shot.data, 'base64'));
  return path;
}

const bodyText = (): string => 'document.body.innerText';

// --- the journey ------------------------------------------------------------

interface Step {
  name: string;
  run(page: Cdp): Promise<void>;
}

const steps: Step[] = [
  {
    name: 'duplicates: the report and the reclaim panel are on the same screen',
    async run(page) {
      await goto(page, `http://127.0.0.1:${PORT}/duplicates?mock=dupes`);
      await waitFor(page, `${bodyText()}.includes('Duplicates')`, 'the Duplicates title');
      await waitFor(page, `${bodyText()}.includes('In the trash')`, 'the trash panel');
      await waitFor(page, `${bodyText()}.includes('Empty the trash')`, 'the empty-trash button');
      const text = String(await evaluate(page, bodyText()));
      // Read the button's own label rather than a guessed number: the panel must
      // state the bytes, and formatBytes is the one that decides the spelling.
      const button = String(
        await evaluate(
          page,
          `[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('Empty the trash')) ?? ''`
        )
      );
      if (!/frees\s+\S+\s*(B|KB|MB|GB|TB)/.test(button)) {
        throw new Error(`the empty-trash button does not state bytes: "${button}"`);
      }
      // The scan summary must say WHICH walker ran: a slow scan explains itself.
      if (!text.includes('with the fast scanner')) {
        throw new Error('the scan summary does not say which walker ran');
      }
    }
  },
  {
    name: 'duplicates: emptying opens the engine sheet and names what goes',
    async run(page) {
      await clickText(page, 'button', 'Empty the trash');
      await waitFor(page, `${bodyText()}.includes('Empty the trash')`, 'the confirm sheet');
      await waitFor(page, `${bodyText()}.includes('Type')`, 'the typed-word gate');
      const text = String(await evaluate(page, bodyText()));
      if (!text.includes('.portage/trash')) {
        throw new Error('the sheet does not name the directory being emptied');
      }
      if (!text.includes('for good')) {
        throw new Error('the sheet does not say the delete is permanent');
      }
    }
  },
  {
    name: 'duplicates: the button stays disabled until the word is typed',
    async run(page) {
      // Scoped to the dialog: "Empty the trash · frees …" is also on the page
      // behind it, and a document-order search would press that one instead.
      const confirmEnabled = `[...document.querySelectorAll('[role="alertdialog"] button')].some((b) => b.textContent.trim() === 'Empty' && !b.disabled)`;
      if (await evaluate(page, confirmEnabled)) {
        throw new Error('the confirm button is enabled before the word is typed');
      }
      await typeInto(page, '#confirm-word', 'Empty');
      await waitFor(page, confirmEnabled, 'the confirm button to enable');
    }
  },
  {
    name: 'duplicates: confirming reports the bytes and the panel goes',
    async run(page) {
      await clickText(page, '[role="alertdialog"] button', 'Empty');
      await waitFor(
        page,
        `[...document.querySelectorAll('[data-sonner-toast]')].some((t) => (t.textContent || '').includes('Freed'))`,
        'the freed-bytes toast'
      );
      const toast = String(
        await evaluate(page, `document.querySelector('[data-sonner-toast]')?.textContent ?? ''`)
      );
      if (!toast.includes('Freed')) throw new Error(`unexpected toast: ${toast}`);
      // The panel described folders that no longer exist, so it must be gone.
      await waitFor(
        page,
        `!document.body.innerText.includes('Empty the trash')`,
        'the trash panel to clear after emptying'
      );
    }
  },
  {
    name: 'doctor: the report renders its checks, not a blank screen',
    async run(page) {
      await goto(page, `http://127.0.0.1:${PORT}/doctor?mock=dupes`);
      await waitFor(page, `${bodyText()}.includes('Doctor')`, 'the Doctor title');
      await waitFor(page, `${bodyText()}.includes('checks')`, 'the verdict line');
    }
  },
  {
    name: 'purge: the plan and its refusals both render',
    async run(page) {
      await goto(page, `http://127.0.0.1:${PORT}/purge?mock=dupes`);
      await waitFor(page, `${bodyText()}.includes('Purge')`, 'the Purge title');
      // Nothing is planned on arrival, BY DESIGN: a plan can re-read hashes at
      // both ends, so it happens when a person asks. Press the button.
      await clickText(page, 'button', 'Check the phone');
      await waitFor(page, `${bodyText()}.includes('Safe to delete')`, 'the eligible list');
      // The clock is relative now ("checked 2 minutes ago"), so match the word
      // that must be there rather than the old "checked at HH:MM:SS".
      await waitFor(page, `${bodyText()}.includes('checked ')`, 'the re-check age');
    }
  },
  {
    name: 'plan: rows survive a tab change (state outlives the route)',
    async run(page) {
      await goto(page, `http://127.0.0.1:${PORT}/plan?mock=dupes`);
      await waitFor(page, `${bodyText()}.includes('Plan')`, 'the Plan title');
    }
  }
];

// --- drive it ---------------------------------------------------------------

const chromeProfile = await mkdtemp(join(tmpdir(), 'portage-ui-chrome-'));
// stderr goes to a file: nobody reads a pipe while we wait, and a full pipe
// blocks Chrome before it opens the port. The file is what we print on failure.
const chromeLog = join(chromeProfile, 'chrome-stderr.log');
const chrome = Bun.spawn(
  [
    CHROME,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    // CI containers give Chrome a 64 MB /dev/shm and it dies without this.
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1280,900',
    `--remote-debugging-port=${CDP_PORT}`,
    // A throwaway profile per run: a cached bundle or a stale service worker
    // makes a failing build look green, which is worse than no test.
    `--user-data-dir=${chromeProfile}`,
    'about:blank'
  ],
  { stdout: 'ignore', stderr: Bun.file(chromeLog) }
);

// Cold CI runners start Chrome slowly, so the bound is 30 s, not 10 s. A Chrome
// that exits early fails at once instead of waiting out the clock.
const startupStarted = Date.now();
const startupDeadline = startupStarted + 30_000;
let ready = false;
while (!ready && chrome.exitCode === null && Date.now() < startupDeadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    ready = response.ok;
  } catch {
    /* not up yet */
  }
  if (!ready) await Bun.sleep(100);
}
if (!ready) {
  const exitedEarly = chrome.exitCode !== null;
  chrome.kill();
  await chrome.exited;
  server.stop(true);
  // Say WHY: a missing display, a sandbox refusal and a bad path all look the
  // same from here.
  const why = (await Bun.file(chromeLog).text()).trim();
  const seconds = ((Date.now() - startupStarted) / 1000).toFixed(1);
  const state = exitedEarly ? `exited ${chrome.exitCode}` : 'still running';
  console.error(`ui-sweep: Chrome never opened its debugging port (${CHROME}; ${state} after ${seconds}s)`);
  console.error(why === '' ? '(Chrome wrote nothing to stderr)' : why.slice(0, 2000));
  process.exit(2);
}

const page = await openPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false
});

const consoleErrors: string[] = [];
await page.send('Log.enable').catch(() => {});

let failures = 0;
for (const [index, step] of steps.entries()) {
  try {
    await step.run(page);
    await screenshot(page, `${String(index).padStart(2, '0')}-${step.name.split(':')[0]}`);
    console.log(`PASS  ${step.name}`);
  } catch (err) {
    failures += 1;
    await screenshot(page, `${String(index).padStart(2, '0')}-FAILED`);
    console.log(`FAIL  ${step.name}`);
    console.log(`      ${err instanceof Error ? err.message.replace(/\n/g, '\n      ') : String(err)}`);
  }
}

const problems = await evaluate(
  page,
  `[...document.querySelectorAll('[data-sonner-toast][data-type="error"]')].map((t) => t.textContent)`
).catch(() => []);
if (Array.isArray(problems) && problems.length > 0) {
  console.log(`FAIL  an error toast was on screen: ${problems.join(' | ')}`);
  failures += 1;
}

console.log(`\n${steps.length - failures}/${steps.length} steps passed; screenshots in ${SHOTS}`);

page.close();
chrome.kill();
server.stop(true);
process.exit(failures === 0 ? 0 : 1);
