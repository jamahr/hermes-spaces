// Renders a space's artifact standalone (same data/theme/bridge injection as the plugin) and
// screenshots it at realistic widths in light and dark. Usage: node render-artifact.cjs <space-dir> <out-dir>
const { chromium } = require('/root/.npm/_npx/314abffa6aaf2cd1/node_modules/playwright');
const fs = require('fs'), path = require('path');
const dir = process.argv[2], out = process.argv[3];
const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } };
const latest = JSON.parse(read('data/latest.json') || 'null');
const history = (read('data/history.jsonl') || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
const brief = JSON.parse(read('brief.json') || 'null');
const space = JSON.parse(read('space.json'));
const viewer = process.env.VIEWER ? JSON.parse(process.env.VIEWER) : {};
const THEMES = {
  light: { '--foreground': '#1d1d1f', '--muted-foreground': '#6e6e73', '--faint-foreground': '#9a9aa0', '--accent': '#2f6fec', '--border': '#e3e3e8', '--card': '#ffffff', '--surface': '#f5f5f7', '--ok': '#2f9e44', '--warn': '#d97706', '--bad': '#e5484d', bg: '#ffffff', scheme: 'light' },
  dark: { '--foreground': '#ececf1', '--muted-foreground': '#9a9aa3', '--faint-foreground': '#6c6c75', '--accent': '#6ea0ff', '--border': '#2e2e35', '--card': '#1c1c21', '--surface': '#232329', '--ok': '#4cc38a', '--warn': '#f0a43a', '--bad': '#ff6b6b', bg: '#151518', scheme: 'dark' },
};
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: '/root/.hermes/tools/chromium-1208/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];
  for (const [tname, t] of Object.entries(THEMES)) {
    for (const width of [820, 1180, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      page.on('pageerror', e => errors.push(`${tname}/${width}: ${e.message}`));
      const vars = Object.entries(t).filter(([k]) => k.startsWith('--')).map(([k, v]) => `${k}:${v}`).join(';');
      const payload = JSON.stringify({ space, latest, history, brief, viewer }).replace(/</g, '\\u003c');
      const head = `<meta charset="utf-8"><style>:root{${vars};--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter',system-ui,sans-serif;color-scheme:${t.scheme}}html,body{margin:0;background:${t.bg};color:var(--foreground);font-family:var(--font)}</style><script>window.SPACE=${payload};window.__asks=[];window.space={ask:p=>window.__asks.push(p),draft:()=>{},openChat:()=>{}};document.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('[data-ask]');if(el){e.preventDefault();window.space.ask(el.getAttribute('data-ask'))}},true)</script>`;
      const html = read('artifact.html').replace(/<head[^>]*>/i, m => m + head);
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const f = path.join(out, `${tname}-${width}.png`);
      await page.screenshot({ path: f, fullPage: true });
      const h = await page.evaluate(() => document.body.scrollHeight);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      console.log(f, 'height', h, overflow ? 'HORIZONTAL OVERFLOW' : '');
      if (tname === 'light' && width === 1180) {
        const n = await page.$$eval('[data-ask]', els => els.length), o = await page.$$eval('[data-open]', els => els.length);
        await page.click('.cell.c-fail'); await page.waitForTimeout(250);
        const opened = await page.evaluate(() => document.getElementById('sheet')?.classList.contains('on'));
        await page.keyboard.press('Escape'); await page.waitForTimeout(250);
        console.log('openable', o, 'askable', n, 'square opens details:', opened, 'asks sent by that click:', JSON.stringify(await page.evaluate(() => window.__asks)));
      }
      await page.close();
    }
  }
  console.log('JS errors', JSON.stringify(errors));
  await browser.close();
})();
