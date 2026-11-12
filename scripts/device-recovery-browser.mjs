import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const base = 'http://127.0.0.1:3210';
const out = process.env.STILL_RECOVERY_OUT;
assert.ok(out && path.isAbsolute(out));
await mkdir(out, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const result = { version: 1, cases: [], responses: [], violations: [], errors: [], success: false };
const responses = [];
const allowed = new Set(['/', '/favicon.svg', '/styles.css', '/app.js', '/editor.js', '/cloud.js', '/storage.js', '/markdown.js', '/api/config']);
const projection = (rows) => rows.map(({ id, title, markdown }) => ({ id, title, markdown })).sort((a, b) => a.id.localeCompare(b.id));
let browser;

async function record(page, replacement) {
  return page.evaluate(async ({ replacement, write }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('still-workspaces', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('workspaces', write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('workspaces');
        const request = write ? store.put(replacement) : store.get('guest');
        tx.oncomplete = () => resolve(write ? replacement : request.result);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => {};
      });
    } finally { db.close(); }
  }, { replacement, write: replacement !== undefined });
}

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#editor')?.contentEditable === 'true'
    && !document.querySelector('#new-page').disabled);
  await page.locator('#page-title').waitFor({ state: 'visible' });
}
async function state(page, value) {
  await page.waitForFunction((value) => document.querySelector('#save-state').textContent === value, value);
}
async function source(page) {
  if (await page.locator('#source-button').getAttribute('aria-pressed') !== 'true') await page.locator('#source-button').click();
}
async function download(page, trigger, name) {
  const pending = page.waitForEvent('download');
  await trigger();
  const value = await pending;
  await value.saveAs(path.join(out, name));
  const bytes = await readFile(path.join(out, name));
  return { bytes, name: value.suggestedFilename(), sha256: hash(bytes) };
}
async function screenshot(page, name) {
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('#recovery-panel');
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      buttons: [...panel.querySelectorAll('button')].map((b) => ({ text: b.textContent, height: b.getBoundingClientRect().height })) };
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1);
  await page.screenshot({ path: path.join(out, name), fullPage: true });
  return geometry;
}

try {
  browser = await chromium.launch({ headless: true });
  for (const [id, options] of [['R01', { viewport: { width: 1440, height: 1000 } }],
    ['R02', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }]]) {
    const item = { id, passed: false, observations: [], downloads: [], contextClosed: false };
    result.cases.push(item);
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', ...options });
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== base || !allowed.has(url.pathname) || url.search || request.method() !== 'GET') {
        result.violations.push({ case: id, url: request.url(), method: request.method() });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => { result.violations.push({ case: id, websocket: socket.url() }); socket.close(); });
    context.on('page', (page) => {
      page.setDefaultTimeout(12_000);
      page.on('pageerror', (error) => result.errors.push({ case: id, message: error.message }));
      page.on('dialog', (dialog) => { if (dialog.type() === 'beforeunload') dialog.accept(); else { result.errors.push({ case: id, dialog: dialog.message() }); dialog.dismiss(); } });
      page.on('response', (response) => {
        const n = responses.length;
        responses.push((async () => {
          const bytes = await response.body();
          const file = `${id}-response-${n}.body`;
          assert.ok(bytes.length < 1_048_576);
          await writeFile(path.join(out, file), bytes);
          result.responses.push({ case: id, url: response.url(), status: response.status(), file, bytes: bytes.length, sha256: hash(bytes) });
          assert.equal(response.status(), 200);
          const relative = new URL(response.url()).pathname;
          if (relative !== '/api/config') assert.deepEqual(bytes, await readFile(path.join('public', relative === '/' ? 'index.html' : relative.slice(1))));
        })());
      });
    });
    try {
      let page = await context.newPage();
      await page.goto(base, { waitUntil: 'networkidle' }); await ready(page);
      await page.locator('#page-title').fill(`${id} retained original`);
      await source(page); await page.locator('#source').fill(`# ${id} saved\n\nExact source  \nUnicode: á 🎈\n`);
      await state(page, 'Saved on this device');
      const saved = await record(page);
      assert.equal(saved.documents.length, 1);
      await page.evaluate(() => localStorage.setItem('still.recovery-test-sentinel', 'untouched'));
      await page.close();
      const fixture = await context.newPage(); await fixture.goto(`${base}/favicon.svg`);
      const damaged = structuredClone(saved);
      damaged.documents = id === 'R01' ? [saved.documents[0], { ...saved.documents[0], title: 'Retain duplicate too' }] : { unreadable: 'authored fixture' };
      await record(fixture, damaged);
      item.observations.push({ stage: 'saved', record: saved }, { stage: 'damaged', record: await record(fixture) });
      page = await context.newPage(); await page.goto(base, { waitUntil: 'networkidle' }); await ready(page);
      await page.locator('#recovery-panel').waitFor({ state: 'visible' }); await state(page, 'Device saving paused');
      await page.locator('#page-title').fill(`${id} unsaved tab`);
      await source(page); await page.locator('#source').fill(`# ${id} unsaved\n\nKeep **every** word.\n`);
      const imported = Buffer.from(`# ${id} imported\r\n\r\nKeep CRLF and two spaces.  \r\n`);
      await page.locator('#file-input').setInputFiles({ name: `${id} imported.md`, mimeType: 'text/markdown', buffer: imported });
      await page.waitForFunction((title) => document.querySelector('#breadcrumb-title').textContent === title, `${id} imported`);
      await state(page, 'Device saving paused');
      assert.deepEqual(await record(fixture), damaged);
      const first = await download(page, () => page.locator('#export-recovery').click(), `${id}-before-retry.json`);
      assert.equal(first.name, 'still-recovery.json');
      const archive = JSON.parse(first.bytes);
      assert.equal(archive.format, 'still-recovery'); assert.equal(archive.version, 1);
      assert.deepEqual(archive.savedPages, id === 'R01' ? damaged.documents : null);
      assert.equal(archive.tabPages.length, 2);
      assert.equal(archive.tabPages.find((d) => d.title === `${id} imported`).markdown, imported.toString());
      assert.equal(archive.tabPages.find((d) => d.title === `${id} unsaved tab`).markdown, `# ${id} unsaved\n\nKeep **every** word.\n`);
      item.downloads.push({ file: `${id}-before-retry.json`, sha256: first.sha256 });
      await page.locator('#notice-close').click(); assert.equal(await page.locator('#recovery-panel').isVisible(), true);
      await page.locator('#retry-workspace').click(); await ready(page); await state(page, 'Device saving paused');
      assert.deepEqual(await record(fixture), damaged);
      const retry = await download(page, () => page.locator('#export-recovery').click(), `${id}-failed-retry.json`);
      const retryArchive = JSON.parse(retry.bytes);
      assert.deepEqual(retryArchive.savedPages, archive.savedPages);
      assert.deepEqual(projection(retryArchive.tabPages), projection(archive.tabPages));
      item.downloads.push({ file: `${id}-failed-retry.json`, sha256: retry.sha256 });
      item.observations.push({ stage: 'failed-retry', record: await record(fixture), archive: retryArchive });
      const geometry = await screenshot(page, `${id}-paused.png`);
      for (const button of geometry.buttons) assert.ok(button.height >= 44);
      item.pausedGeometry = geometry;
      await record(fixture, saved);
      await page.locator('#retry-workspace').click(); await ready(page); await state(page, 'Saved on this device');
      assert.equal(await page.locator('#recovery-panel').isVisible(), false);
      const merged = await record(fixture);
      const expected = projection([...saved.documents, ...archive.tabPages]);
      assert.deepEqual(projection(merged.documents), expected);
      assert.equal(new Set(merged.documents.map((d) => d.id)).size, 3);
      await page.reload({ waitUntil: 'networkidle' }); await ready(page); await state(page, 'Saved on this device');
      assert.deepEqual(projection((await record(fixture)).documents), expected);
      assert.equal(await page.locator('#page-count').textContent(), '3');
      assert.equal(await page.evaluate(() => localStorage.getItem('still.recovery-test-sentinel')), 'untouched');
      await page.locator('#more-button').click();
      const markdown = await download(page, () => page.locator('#export-button').click(), `${id}-restored.md`);
      assert.deepEqual(markdown.bytes, imported);
      item.downloads.push({ file: `${id}-restored.md`, sha256: markdown.sha256 });
      item.observations.push({ stage: 'recovered-reloaded', record: await record(fixture) });
      item.recoveredGeometry = await screenshot(page, `${id}-recovered.png`);
      item.passed = true;
    } catch (error) {
      item.error = error.stack; throw error;
    } finally { await context.close(); item.contextClosed = true; }
  }
  await Promise.all(responses);
  assert.deepEqual(result.violations, []); assert.deepEqual(result.errors, []);
  result.success = result.cases.length === 2 && result.cases.every((c) => c.passed && c.contextClosed);
} catch (error) { result.error = error.stack; process.exitCode = 1; }
finally {
  const pending = await Promise.allSettled(responses);
  result.responseFailures = pending.filter((r) => r.status === 'rejected').map((r) => String(r.reason));
  if (result.responseFailures.length) { result.success = false; process.exitCode = 1; }
  if (browser) { await browser.close(); result.browserClosed = true; }
  await writeFile(path.join(out, 'browser.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ success: result.success, cases: result.cases.map(({ id, passed, error }) => ({ id, passed, error })), responses: result.responses.length }));
}
