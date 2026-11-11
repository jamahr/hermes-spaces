// Live end-to-end test in the loopback Webapp (real gateway UI, real plugin backend, real bot):
// hub → space → click a failed square in the artifact → question appears in the Ask panel →
// the bot's answer streams in → screenshots at a Mac-like 1440x900 viewport.
//   node >= 20:  /root/.hermes/tools/node-*/bin/node tests/live-ui.cjs [outdir]
//   SIDE=9131    route plugin API calls to tests/side_backend.py (exercise unreleased backend code)
//   DARK=1       dark colour scheme
const { chromium } = require('/root/.npm/_npx/314abffa6aaf2cd1/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const shots = process.argv[2] || path.join(__dirname, '..', 'screenshots');
const SIDE = process.env.SIDE;
(async () => {
  const login = spawn('hermes', ['webapp', '--no-open', '--skip-build'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; login.stdout.on('data', b => out += b); login.stderr.on('data', b => out += b);
  let url; for (let i = 0; i < 150; i++) { url = out.match(/http:\/\/127[^\s]+/)?.[0]; if (url) break; await new Promise(r => setTimeout(r, 100)); }
  if (!url) { console.log('NO LOGIN LINK', out.slice(-500)); process.exit(1); }
  const browser = await chromium.launch({ headless: true, executablePath: '/root/.hermes/tools/chromium-1208/chrome-linux/chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: process.env.DARK ? 'dark' : 'light' });
  await context.addInitScript(() => { try { localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ 'hermes-spaces': true })) } catch { /* sandboxed artifact frame */ } });
  if (SIDE) {
    await context.route('**/api/plugins/hermes-spaces/**', async route => {
      const u = new URL(route.request().url());
      const r = await fetch(`http://127.0.0.1:${SIDE}${u.pathname}${u.search}`, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().postData() || undefined });
      await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' }, body: await r.text() });
    });
  }
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  fs.mkdirSync(shots, { recursive: true });
  const t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const asks = () => page.evaluate(async () => {
    const tok = sessionStorage.getItem(`hermes.webapp.session.v1:${JSON.stringify([location.origin, ''])}`);
    const r = await fetch('/api/plugins/hermes-spaces/spaces/gbrain-health/asks', { headers: { 'X-Hermes-Session-Token': tok } });
    return r.ok ? r.json() : { status: r.status };
  });
  try {
    await page.goto(url); await page.waitForTimeout(4000);
    await page.goto('http://127.0.0.1:9120/#/spaces'); await page.getByText('gbrain Health').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800); await page.screenshot({ path: path.join(shots, 'app-hub.png') }); console.log(T(), 'HUB OK');
    for (let i = 0; i < 3; i++) {  // the shell may still be settling its initial route; re-enter via the sidebar
      if (await page.getByText('gbrain Health').first().isVisible().catch(() => false)) break
      await page.getByText('Spaces', { exact: true }).first().click(); await page.waitForTimeout(1500)
    }
    await page.getByText('gbrain Health').first().click();
    await page.waitForSelector('iframe[title="gbrain Health space"]', { timeout: 20000 }); await page.waitForTimeout(2500);
    let f = null; for (const c of page.frames()) { if (await c.$('#app .headline').catch(() => null)) { f = c; break } }
    console.log(T(), 'ARTIFACT', f ? await f.textContent('.headline') : 'NOT FOUND');
    await page.screenshot({ path: path.join(shots, 'app-space.png') });
    console.log(T(), 'ASKS API before', JSON.stringify(await asks()).slice(0, 120));
    await (await f.$('.cell.c-fail')).click(); console.log(T(), 'CLICKED a failed square');
    await page.getByText('What happened, and does it matter?', { exact: false }).first().waitFor({ timeout: 15000 }); console.log(T(), 'QUESTION IN PANEL');
    await page.waitForTimeout(5000); await page.screenshot({ path: path.join(shots, 'app-asking.png') });
    let a = null;
    for (let i = 0; i < 150; i++) {
      const r = await asks(); a = (r.asks || [])[r.asks?.length - 1];
      if (a && ['done', 'error'].includes(a.state)) break
      await page.waitForTimeout(1500);
    }
    console.log(T(), 'ANSWER', a?.state, (a?.steps || []).map(s => s.label).join(' > '), '\n' + (a?.answer || a?.error));
    await page.waitForTimeout(2500); await page.screenshot({ path: path.join(shots, 'app-answered.png') });
    // follow-up typed in the panel, same conversation
    await page.getByPlaceholder('Ask about anything on this page').fill('And will tonight be any different?');
    await page.keyboard.press('Enter'); console.log(T(), 'FOLLOW-UP SENT');
    for (let i = 0; i < 150; i++) {
      const r = await asks(); a = (r.asks || [])[r.asks?.length - 1];
      if (a && a.question.startsWith('And will') && ['done', 'error'].includes(a.state)) break
      await page.waitForTimeout(1500);
    }
    console.log(T(), 'FOLLOW-UP', a?.state, (a?.steps || []).map(s => s.label).join(' > '), '\n' + (a?.answer || a?.error));
    await page.waitForTimeout(2500); await page.screenshot({ path: path.join(shots, 'app-followup.png') });
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1; await page.screenshot({ path: path.join(shots, 'app-fail.png') }) }
  finally { console.log('JS_ERRORS', JSON.stringify(errors).slice(0, 1200)); await browser.close(); login.kill(); }
})();
