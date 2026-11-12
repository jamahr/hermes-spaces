// Live Approve test in the loopback Webapp: open a space, open a details sheet (must not touch chat),
// press Approve -> Run it, and wait for the bot's result to land on the card.
// Use a harmless test space. Usage: SIDE=<port> node tests/approve-ui.cjs <space-id> [outdir]
const { chromium } = require('/root/.npm/_npx/314abffa6aaf2cd1/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const SPACE = process.argv[2], shots = process.argv[3] || path.join(__dirname, '..', 'screenshots'), SIDE = process.env.SIDE;
if (!SPACE) { console.log('usage: approve-ui.cjs <space-id> [outdir]'); process.exit(2); }
(async () => {
  const login = spawn('hermes', ['webapp', '--no-open', '--skip-build'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; login.stdout.on('data', b => out += b); login.stderr.on('data', b => out += b);
  let url; for (let i = 0; i < 150; i++) { url = out.match(/http:\/\/127[^\s]+/)?.[0]; if (url) break; await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ headless: true, executablePath: '/root/.hermes/tools/chromium-1208/chrome-linux/chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ 'hermes-spaces': true })) } catch { } });
  if (SIDE) await context.route('**/api/plugins/hermes-spaces/**', async route => {
    const u = new URL(route.request().url());
    const r = await fetch(`http://127.0.0.1:${SIDE}${u.pathname}${u.search}`, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().postData() || undefined });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' }, body: await r.text() });
  });
  const page = await context.newPage(), errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/hermes-spaces/') && r.method() === 'POST') calls.push(new URL(r.url()).pathname.split('/').slice(-1)[0]); });
  fs.mkdirSync(shots, { recursive: true });
  const t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  try {
    await page.goto(url); await page.waitForTimeout(4000);
    await page.goto('http://127.0.0.1:9120/#/spaces'); await page.waitForTimeout(2000);
    const title = JSON.parse(fs.readFileSync(`/root/.hermes/spaces/${SPACE}/space.json`, 'utf8')).title;
    for (let i = 0; i < 4; i++) {  // the shell may still be settling its initial route; re-enter via the sidebar
      if (await page.getByText(title, { exact: true }).first().isVisible().catch(() => false)) break
      await page.getByText('Spaces', { exact: true }).first().click(); await page.waitForTimeout(1500)
    }
    await page.getByText(title, { exact: true }).first().click();
    await page.waitForSelector('iframe[title$=" space"]', { timeout: 20000 }); await page.waitForTimeout(2500);
    let f = null;
    for (let i = 0; i < 20 && !f; i++) { for (const c of page.frames()) { if (await c.$('#app .headline').catch(() => null)) { f = c; break } } if (!f) await page.waitForTimeout(1000) }
    if (!f) { console.log('frames:', page.frames().map(x => x.url().slice(0, 60)).join(' ; '), '\nbody:', (await page.innerText('body')).slice(0, 400)); throw new Error('artifact frame not found') }
    console.log(T(), 'ARTIFACT', await f.textContent('.headline'));
    // a drill-down must open instantly and send nothing to chat
    const before = calls.length;
    await (await f.$('.cell.c-fail')).click(); await f.waitForSelector('#sheet.on', { timeout: 3000 });
    console.log(T(), 'SHEET', await f.textContent('#sh-title'), '| chat calls made:', calls.length - before);
    await page.screenshot({ path: path.join(shots, 'approve-sheet.png') });
    await f.press('body', 'Escape'); await page.waitForTimeout(400);
    await (await f.$('[data-approve]')).click(); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'approve-confirm.png') });
    await (await f.$('[data-go]')).click(); console.log(T(), 'RUN IT clicked; POSTs:', calls.join(','));
    let txt = '';
    for (let i = 0; i < 200; i++) {
      txt = await f.evaluate(() => document.querySelector('.approve .job')?.innerText || '');
      if (/^\S*\s*(Done|Didn’t work|Needs you)/m.test(txt) || /Done:|Didn’t work:|Needs you:/.test(txt)) break;
      if (i === 6) await page.screenshot({ path: path.join(shots, 'approve-running.png') });
      await page.waitForTimeout(2000);
    }
    console.log(T(), 'CARD:', txt.replace(/\n/g, ' | '));
    await page.waitForTimeout(1500); await page.screenshot({ path: path.join(shots, 'approve-result.png') });
    console.log('ask calls (should be 0):', calls.filter(c => c === 'ask').length);
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1; await page.screenshot({ path: path.join(shots, 'approve-fail.png') }) }
  finally { console.log('JS_ERRORS', JSON.stringify(errors).slice(0, 600)); await browser.close(); login.kill(); }
})();
