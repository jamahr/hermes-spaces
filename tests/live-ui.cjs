// Live smoke test: renders the Spaces hub and the gbrain Health space in the loopback Webapp,
// checks the backend, and verifies a click inside the sandboxed artifact reaches the bot bridge.
const { chromium } = require('/root/.npm/_npx/314abffa6aaf2cd1/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const shots = path.join(__dirname, '..', 'screenshots');
(async () => {
  const login = spawn('hermes', ['webapp', '--no-open', '--skip-build'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; login.stdout.on('data', b => out += b); login.stderr.on('data', b => out += b);
  let url; for (let i = 0; i < 150; i++) { url = out.match(/http:\/\/127[^\s]+/)?.[0]; if (url) break; await new Promise(r => setTimeout(r, 100)); }
  if (!url) { console.log('NO LOGIN LINK', out.slice(-500)); process.exit(1); }
  const browser = await chromium.launch({ headless: true, executablePath: '/root/.hermes/tools/chromium-1208/chrome-linux/chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ 'hermes-spaces': true })));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) });
  await fs.promises.mkdir(shots, { recursive: true });
  try {
    await page.goto(url); await page.waitForTimeout(4500);
    const api = await page.evaluate(async () => {
      const tok = sessionStorage.getItem(`hermes.webapp.session.v1:${JSON.stringify([location.origin, ''])}`);
      const r = await fetch('/api/plugins/hermes-spaces/spaces', { headers: { 'X-Hermes-Session-Token': tok } });
      return { status: r.status, body: await r.text() };
    });
    console.log('API', api.status, api.body.slice(0, 300));
    await page.goto(url.split('#')[0].replace(/\?.*$/, '') + '#/spaces'); await page.waitForTimeout(1500);
    await page.goto('http://127.0.0.1:9120/#/spaces'); await page.getByText('gbrain Health').first().waitFor({ timeout: 20000 });
    console.log('HUB OK'); await page.screenshot({ path: path.join(shots, 'hub.png') });
    await page.getByText('gbrain Health').first().click();
    const frameEl = await page.waitForSelector('iframe[title="gbrain Health space"]', { timeout: 20000 });
    await page.waitForTimeout(3000);
    const frame = await frameEl.contentFrame();
    // Webapp nests the guest in a shell; find the frame that has our content.
    let f = frame; for (const c of page.frames()) { if (await c.$('#app h1').catch(() => null)) { f = c; break } }
    const h1 = await f.textContent('#app h1'); const headline = await f.textContent('.headline');
    const checks = await f.$$eval('.check', els => els.length);
    console.log('ARTIFACT', h1, '|', headline, '| checks', checks);
    await page.screenshot({ path: path.join(shots, 'space.png'), fullPage: false });
    // Ask-back bridge: capture the postMessage from the artifact at the parent.
    await page.evaluate(() => { window.__asks = []; window.addEventListener('message', e => { if (e.data?.type === 'hermes-space-ask') window.__asks.push(e.data.prompt) }) });
    await f.click('.check.t-bad');
    await page.waitForTimeout(4000);
    console.log('ASK CAPTURED', JSON.stringify(await page.evaluate(() => window.__asks)).slice(0, 300));
    await page.screenshot({ path: path.join(shots, 'after-ask.png') });
    console.log('BODY TAIL', (await page.locator('body').innerText()).slice(-1200));
  } catch (e) { console.log('FAIL', e.message); console.log('BODY', (await page.locator('body').innerText()).slice(-2500)); process.exitCode = 1 }
  finally { console.log('JS_ERRORS', JSON.stringify(errors).slice(0, 1500)); await page.screenshot({ path: path.join(shots, 'last.png') }); await browser.close(); login.kill(); }
})();
