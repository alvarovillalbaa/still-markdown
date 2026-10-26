import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Playwright is supplied by the CI tools directory, never by app dependencies.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const target = new URL(process.env.BASE_URL || '');
if (target.username || target.password || target.pathname !== '/' || target.search || target.hash
  || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) {
  throw new Error('BASE_URL must be an HTTPS origin, or an HTTP localhost origin.');
}
const base = target.origin;
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const run = `${Date.now()}-${randomUUID().slice(0, 8)}`;
// Supply an explicitly authorized, already-confirmed fixture account. Never
// weaken production confirmation or create a random signup for browser checks.
const email = process.env.STILL_CONFIRMED_EMAIL?.trim() || '';
const password = process.env.STILL_CONFIRMED_PASSWORD || '';
const secrets = [password, email];
const evidence = { target: base, started_at: new Date().toISOString(), passed: [], user_id: null, cloud_page_id: null, success: false,
  auth_method: 'confirmed_fixture_signin', signup_exercised: false, smtp_delivery_proven: false };
const browserErrors = [];
const contexts = [];
let activePage;
let activeStep = 'launch';
let browser;

function scrub(value) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/still_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-session]');
}

async function step(name, operation) {
  activeStep = name;
  process.stdout.write(`CHECK ${name}\n`);
  await operation();
  evidence.passed.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function newContext(options) {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  contexts.push(context);
  context.on('page', (page) => {
    page.on('pageerror', (error) => browserErrors.push(scrub(error.message)));
    page.on('dialog', (dialog) => dialog.dismiss());
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.pathname !== '/auth/v1/token' || url.searchParams.get('grant_type') !== 'password' || response.request().method() !== 'POST') return;
      try {
        const data = await response.json();
        const id = data.user?.id || data.id;
        if (/^[0-9a-f-]{36}$/i.test(id || '')) evidence.user_id = id;
      } catch { /* UI assertions provide the failure detail without logging credentials. */ }
    });
  });
  return context;
}

async function ready(page) {
  activePage = page;
  await page.goto(base, { waitUntil: 'load' });
  await page.locator('#editor').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#new-page').disabled
    && document.querySelector('#editor').getAttribute('contenteditable') === 'true');
}

async function textIs(page, selector, value, timeout = 20_000) {
  await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent === value, { selector, value }, { timeout });
}

async function sourceMode(page, enabled) {
  if ((await page.locator('#source-button').getAttribute('aria-pressed') === 'true') !== enabled) await page.locator('#source-button').click();
  await page.locator(enabled ? '#source' : '#editor').waitFor({ state: 'visible' });
}

async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `Document overflows horizontally: ${JSON.stringify(dimensions)}`);
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(artifacts, name), fullPage: true,
    mask: [page.locator('#password'), page.locator('#token-value')] });
}

async function exportedMarkdown(page, name) {
  await page.locator('#more-button').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloadEvent;
  const file = path.join(artifacts, name);
  await download.saveAs(file);
  return readFile(file);
}

async function mcp(token, method, params = {}) {
  const response = await fetch(`${base}/api/mcp`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

async function tokenFromUI(page, name, scope) {
  await page.locator('#token-name').fill(name);
  await page.locator('#token-scope').selectOption(scope);
  await page.locator('#create-token').click();
  await page.waitForFunction(() => /^still_[A-Za-z0-9_-]{43}$/.test(document.querySelector('#token-value').value), null, { timeout: 20_000 });
  const token = await page.locator('#token-value').inputValue();
  secrets.push(token);
  return token;
}

async function revokeFromUI(page, name, token) {
  const row = page.locator('#token-list .token-row').filter({ hasText: name });
  await row.locator('button').click();
  await row.waitFor({ state: 'detached' });
  const revoked = await mcp(token, 'tools/list');
  assert.equal(revoked.status, 401, 'Revoked bearer token must fail discovery.');
}

try {
  browser = await chromium.launch({ headless: true });
  const desktopContext = await newContext({ viewport: { width: 1440, height: 1000 } });
  const desktop = await desktopContext.newPage();
  desktop.setDefaultTimeout(15_000);

  await step('desktop blank page and native typing', async () => {
    await ready(desktop);
    assert.equal(await desktop.locator('#page-title').inputValue(), '');
    assert.equal(await desktop.locator('#editor').textContent(), '');
    assert.equal(await desktop.locator('#format-toolbar').isVisible(), false);
    await screenshot(desktop, '01-desktop-blank.png');
    await desktop.locator('#page-title').fill(`Guest browser proof ${run}`);
    await desktop.locator('#editor').click();
    await desktop.keyboard.type('A quiet thought', { delay: 12 });
    await textIs(desktop, '#editor', 'A quiet thought');
    await textIs(desktop, '#save-state', 'Saved on this device');
    await noOverflow(desktop);
  });

  await step('selected text toolbar applies bold to the selection', async () => {
    await desktop.locator('#editor').evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const index = walker.currentNode.textContent.indexOf('quiet');
        if (index === -1) continue;
        const range = document.createRange(); range.setStart(walker.currentNode, index); range.setEnd(walker.currentNode, index + 5);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return;
      }
      throw new Error('Selection fixture text missing.');
    });
    await desktop.locator('#format-toolbar').waitFor({ state: 'visible' });
    await desktop.locator('[data-format="bold"]').click();
    assert.equal(await desktop.locator('#editor strong').textContent(), 'quiet');
    assert.equal(await desktop.locator('#editor').textContent(), 'A quiet thought');
    await sourceMode(desktop, true);
    assert.equal(await desktop.locator('#source').inputValue(), 'A **quiet** thought');
  });

  const exactSource = '# Source fidelity\n\nKeep  two spaces.  \nA literal \\* and [^extension].\n\n[^extension]: Source-only extension\n\n';
  await step('source input remains exact without a rich edit', async () => {
    await desktop.locator('#source').fill(exactSource);
    await textIs(desktop, '#save-state', 'Saved on this device');
    await sourceMode(desktop, false);
    await sourceMode(desktop, true);
    assert.equal(await desktop.locator('#source').inputValue(), exactSource);
    assert.equal((await exportedMarkdown(desktop, 'source-exact.md')).toString('utf8'), exactSource);
    await sourceMode(desktop, false);
  });

  const imported = [
    '# Imported proof', '',
    '- [x] Complete task', '- [ ] Open task', '- Parent', '  - Nested child', '',
    'Inline spaces: `  ` and [Docs](https://example.com/a_(b) "Reference").', '',
    '![Local icon](/favicon.svg "Image title")', '',
    '```txt', '\tcode with trailing spaces  ', '```', '',
    '| Left | Right |', '| :--- | ---: |', '| a\\|b | safe |', '',
    '<script>window.__stillBrowserUnsafe = true</script>',
    '<img src=x onerror="window.__stillBrowserUnsafe = true">',
    '[Unsafe](javascript:alert(1))', '',
  ].join('\r\n');

  await step('Markdown import and byte-preserving export including CRLF', async () => {
    await desktop.locator('#file-input').setInputFiles({ name: `Browser import ${run}.md`, mimeType: 'text/markdown', buffer: Buffer.from(imported) });
    await textIs(desktop, '#breadcrumb-title', `Browser import ${run}`);
    assert.equal(await desktop.locator('#editor h1').textContent(), 'Imported proof');
    assert.deepEqual(await exportedMarkdown(desktop, 'import-original.md'), Buffer.from(imported));
    await sourceMode(desktop, true);
    assert.equal(await desktop.locator('#source').inputValue(), imported.replace(/\r\n/g, '\n'));
    assert.deepEqual(await exportedMarkdown(desktop, 'import-untouched-source.md'), Buffer.from(imported));
    await sourceMode(desktop, false);
    assert.deepEqual(await exportedMarkdown(desktop, 'import-untouched-rich.md'), Buffer.from(imported));
    await textIs(desktop, '#save-state', 'Saved on this device');
    await desktop.reload({ waitUntil: 'load' });
    await textIs(desktop, '#breadcrumb-title', `Browser import ${run}`);
    assert.deepEqual(await exportedMarkdown(desktop, 'import-after-reload.md'), Buffer.from(imported));
  });

  await step('first rich edit preserves tasks, nesting, code and safe markup', async () => {
    assert.equal(await desktop.locator('#editor input[type="checkbox"]').count(), 2);
    assert.equal(await desktop.locator('#editor input[type="checkbox"]').first().isChecked(), true);
    await desktop.locator('#editor input[type="checkbox"]').first().uncheck();
    await textIs(desktop, '#save-state', 'Saved on this device');
    await sourceMode(desktop, true);
    assert.match(await desktop.locator('#source').inputValue(), /- \[ \] Complete task/);
    await sourceMode(desktop, false);
    assert.equal(await desktop.locator('#editor input[type="checkbox"]').first().isChecked(), false);
    assert.equal(await desktop.locator('#editor ul ul li').textContent(), 'Nested child');
    assert.equal(await desktop.locator('#editor p code').textContent(), '  ');
    assert.equal(await desktop.locator('#editor pre code').textContent(), '\tcode with trailing spaces  ');
    assert.equal(await desktop.locator('#editor a').filter({ hasText: 'Docs' }).getAttribute('title'), 'Reference');
    assert.equal(await desktop.locator('#editor img').getAttribute('title'), 'Image title');
    assert.equal(await desktop.locator('#editor tbody td').first().textContent(), 'a|b');
    assert.equal(await desktop.locator('#editor script,#editor [onerror],#editor a[href^="javascript:"]').count(), 0);
    assert.equal(await desktop.evaluate(() => window.__stillBrowserUnsafe), undefined);
    await noOverflow(desktop);
    await screenshot(desktop, '02-desktop-rich-import.png');
  });

  await step('page search and focus mode', async () => {
    await desktop.locator('#search').fill(`Browser import ${run}`);
    assert.equal(await desktop.locator('#page-list .page-item').count(), 1);
    await desktop.locator('#search').fill('no-page-has-this-unique-text');
    await desktop.locator('#list-message').waitFor({ state: 'visible' });
    assert.equal(await desktop.locator('#page-list .page-item').count(), 0);
    await desktop.locator('#search').fill('');
    await desktop.locator('#focus-button').click();
    assert.match(await desktop.locator('#app').getAttribute('class'), /focus-mode/);
    await noOverflow(desktop);
    await desktop.locator('#focus-button').click();
  });

  await step('mobile writing, sidebar, modal focus and viewport fit', async () => {
    const mobileContext = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    await ready(mobile);
    assert.equal(await mobile.locator('#editor').textContent(), '');
    await mobile.locator('#sidebar-toggle').click();
    assert.match(await mobile.locator('#app').getAttribute('class'), /sidebar-open/);
    await mobile.locator('#new-page').click();
    await mobile.locator('#page-title').fill('Mobile browser proof');
    await mobile.locator('#editor').click(); await mobile.keyboard.type('Room to write on a small screen.');
    await textIs(mobile, '#editor', 'Room to write on a small screen.');
    await noOverflow(mobile);
    await screenshot(mobile, '04-mobile-writing.png');
    await mobile.locator('#sidebar-toggle').click(); await mobile.locator('#account-button').click();
    await mobile.locator('#auth-dialog').waitFor({ state: 'visible' });
    for (let index = 0; index < 8; index++) {
      assert.equal(await mobile.evaluate(() => Boolean(document.activeElement?.closest('#auth-dialog'))), true, 'Modal focus escaped its dialog.');
      await mobile.keyboard.press('Tab');
    }
    const bounds = await mobile.locator('#auth-dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'Mobile dialog exceeds viewport width.');
    await noOverflow(mobile);
    await screenshot(mobile, '05-mobile-dialog.png');
    await mobile.locator('#auth-dialog [data-close]').click();
    await mobile.locator('#close-sidebar').click();
    assert.doesNotMatch(await mobile.locator('#app').getAttribute('class'), /sidebar-open/);
    await mobile.reload({ waitUntil: 'load' });
    await textIs(mobile, '#editor', 'Room to write on a small screen.');
  });

  let cloudDocument;
  const cloudTitle = `Cloud browser proof ${run}`;
  const cloudText = `Private cloud browser page ${run}`;
  await step('confirmed fixture sign-in and private cloud save', async () => {
    activePage = desktop;
    if (!email || !password) throw new Error('Set STILL_CONFIRMED_EMAIL and STILL_CONFIRMED_PASSWORD for an authorized, already-confirmed fixture account. This check does not create an account or prove SMTP delivery.');
    await desktop.locator('#account-button').click();
    await desktop.locator('#signin-tab').click();
    await desktop.locator('#email').fill(email);
    await desktop.locator('#password').fill(password);
    await desktop.waitForFunction(() => !document.querySelector('#auth-submit').disabled
      || Boolean(document.querySelector('#auth-error').textContent.trim()), null, { timeout: 15_000 });
    if (await desktop.locator('#auth-submit').isDisabled()) {
      evidence.auth_message = scrub((await desktop.locator('#auth-error').textContent()).trim().slice(0, 500));
      throw new Error(`Confirmed-account sign-in is unavailable: ${evidence.auth_message}`);
    }
    await desktop.locator('#auth-submit').click();
    await desktop.waitForFunction(() => !document.querySelector('#auth-dialog').open
      || Boolean(document.querySelector('#auth-error').textContent.trim()), null, { timeout: 30_000 });
    if (await desktop.locator('#auth-dialog').evaluate((dialog) => dialog.open)) {
      evidence.auth_message = scrub((await desktop.locator('#auth-error').textContent()).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500));
      throw new Error(`Confirmed-account sign-in did not complete. Auth message: ${evidence.auth_message}`);
    }
    await textIs(desktop, '#account-name', email, 30_000);
    await desktop.waitForFunction(() => !document.querySelector('#new-page').disabled);
    // The supplied fixture may already contain pages from another check. Only
    // create and edit this run's page; never reuse its currently selected page.
    await desktop.locator('#new-page').click();
    await desktop.locator('#page-title').fill(cloudTitle);
    await desktop.locator('#editor').click();
    await desktop.keyboard.type(cloudText);
    await textIs(desktop, '#save-state', 'All changes saved', 30_000);
    cloudDocument = await desktop.evaluate(async ({ email, title }) => {
      const config = await (await fetch('/api/config')).json();
      let session;
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('still.auth.')) continue;
        try { const value = JSON.parse(localStorage.getItem(key)); if (value?.user?.email === email && value.access_token) session = value; } catch { /* Ignore non-session entries. */ }
      }
      if (!session) throw new Error('Signed-in session missing from browser storage.');
      const query = new URLSearchParams({ select: 'id,title,markdown,version', title: `eq.${title}` });
      const response = await fetch(`${config.url}/rest/v1/documents?${query}`, { headers: { apikey: config.publishableKey, Authorization: `Bearer ${session.access_token}` } });
      if (!response.ok) throw new Error(`Direct cloud verification returned ${response.status}.`);
      const rows = await response.json();
      if (rows.length !== 1) throw new Error('Expected exactly one saved synthetic page.');
      return { ...rows[0], user_id: session.user.id };
    }, { email, title: cloudTitle });
    evidence.user_id = cloudDocument.user_id; evidence.cloud_page_id = cloudDocument.id;
    assert.equal(cloudDocument.markdown, cloudText);
    assert.ok(Number.isInteger(cloudDocument.version));
    await desktop.locator('#guest-upload').waitFor({ state: 'visible' });
    await desktop.reload({ waitUntil: 'load' });
    await textIs(desktop, '#account-name', email, 30_000);
    await textIs(desktop, '#breadcrumb-title', cloudTitle, 30_000);
    await textIs(desktop, '#editor', cloudText);
    await screenshot(desktop, '03-desktop-cloud.png');
  });

  await step('fresh browser sign-in reads the cloud page', async () => {
    const freshContext = await newContext({ viewport: { width: 1280, height: 900 } });
    const fresh = await freshContext.newPage(); activePage = fresh;
    await ready(fresh);
    await fresh.locator('#account-button').click();
    await fresh.locator('#signin-tab').click();
    await fresh.locator('#email').fill(email);
    await fresh.locator('#password').fill(password);
    await fresh.locator('#auth-submit').click();
    await textIs(fresh, '#account-name', email, 30_000);
    await textIs(fresh, '#breadcrumb-title', cloudTitle, 30_000);
    await textIs(fresh, '#editor', cloudText);
    await freshContext.close(); activePage = desktop;
  });

  await step('UI-issued read token accesses MCP and revocation rejects it', async () => {
    await desktop.locator('#connect-button').click();
    const name = `Browser read ${run}`;
    const token = await tokenFromUI(desktop, name, 'read');
    assert.equal(await desktop.locator('#mcp-url').inputValue(), `${base}/api/mcp`);
    const initialized = await mcp(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'still-browser-proof', version: '1' } });
    assert.equal(initialized.status, 200); assert.equal(initialized.body.result.protocolVersion, '2025-11-25');
    const tools = await mcp(token, 'tools/list');
    assert.deepEqual(tools.body.result.tools.map((tool) => tool.name).sort(), ['get_document', 'list_documents', 'search_documents']);
    const read = await mcp(token, 'tools/call', { name: 'get_document', arguments: { id: cloudDocument.id } });
    assert.equal(read.body.result.structuredContent.markdown, cloudText);
    const forbidden = await mcp(token, 'tools/call', { name: 'create_document', arguments: { title: 'Must not exist', markdown: 'Read-only write should fail.' } });
    assert.equal(forbidden.body.result.isError, true);
    await revokeFromUI(desktop, name, token);
    await desktop.locator('#connect-dialog [data-close]').click();
  });

  await step('MCP write checks versions and becomes visible in the browser', async () => {
    await desktop.locator('#connect-button').click();
    const name = `Browser write ${run}`;
    const token = await tokenFromUI(desktop, name, 'write');
    const markdown = `${cloudText}\n\nFrom MCP.`;
    const args = { id: cloudDocument.id, title: cloudTitle, markdown, expected_version: cloudDocument.version };
    const updated = await mcp(token, 'tools/call', { name: 'update_document', arguments: args });
    assert.equal(updated.body.result.isError, false);
    assert.equal(updated.body.result.structuredContent.version, cloudDocument.version + 1);
    const stale = await mcp(token, 'tools/call', { name: 'update_document', arguments: { ...args, markdown: 'A stale write must never replace the page.' } });
    assert.equal(stale.body.result.isError, true);
    await revokeFromUI(desktop, name, token);
    await desktop.locator('#connect-dialog [data-close]').click();
    await desktop.reload({ waitUntil: 'load' });
    await textIs(desktop, '#breadcrumb-title', cloudTitle, 30_000);
    await desktop.waitForFunction(() => document.querySelector('#editor').textContent.includes('From MCP.'));
    await sourceMode(desktop, true);
    assert.equal(await desktop.locator('#source').inputValue(), markdown);
    await sourceMode(desktop, false);
    await desktop.locator('#account-button').click();
    await desktop.locator('#signout-button').click();
    await textIs(desktop, '#account-name', 'Your own little space', 30_000);
    await textIs(desktop, '#breadcrumb-title', `Browser import ${run}`, 30_000);
  });

  await step('no uncaught browser errors', async () => assert.deepEqual(browserErrors, []));
  evidence.success = true;
  process.stdout.write('Browser verification passed using a confirmed fixture account. This does not prove signup, confirmation-email delivery, or password-reset delivery.\n');
} catch (error) {
  evidence.failed_step = activeStep;
  const detail = scrub(error.stack || error.message || error);
  process.stderr.write(`FAIL ${activeStep}\n${detail}\n`);
  await writeFile(path.join(artifacts, 'browser-failure.txt'), detail);
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'browser-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  evidence.finished_at = new Date().toISOString();
  evidence.browser_errors = browserErrors;
  await writeFile(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
  if (evidence.user_id) await writeFile(path.join(artifacts, 'fixture-data-cleanup.json'), JSON.stringify({ user_id: evidence.user_id, page_id: evidence.cloud_page_id, delete_user: false }, null, 2));
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
