// Opens every drill-down sheet in a space artifact (standalone, mocked bridge) and screenshots it.
// Fails on JS errors or empty sheets. Usage: node tests/sheets.cjs <space-dir> <out-dir> [width]
const { chromium } = require('/root/.npm/_npx/314abffa6aaf2cd1/node_modules/playwright');
const fs = require('fs'), path = require('path');
const dir = process.argv[2], out = process.argv[3], width = +(process.argv[4] || 1180);
const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } };
const S = {
  space: JSON.parse(read('space.json')), latest: JSON.parse(read('data/latest.json')), brief: JSON.parse(read('brief.json') || 'null'),
  history: (read('data/history.jsonl') || '').split('\n').filter(Boolean).map(l => JSON.parse(l)), viewer: {}
};
const vars = '--foreground:#1d1d1f;--muted-foreground:#6e6e73;--accent:#2f6fec;--border:#e3e3e8;--card:#fff;--warn:#d97706';
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ executablePath: '/root/.hermes/tools/chromium-1208/chrome-linux/chrome', args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width, height: 900 } });
  const errors = [], posted = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.exposeFunction('__post', m => posted.push(m));
  const head = `<meta charset="utf-8"><style>:root{${vars};--font:system-ui}html,body{margin:0;background:#fff;color:var(--foreground);font-family:var(--font)}</style><script>window.SPACE=${JSON.stringify(S).replace(/</g, '\\u003c')};window.space={ask:q=>__post({ask:q}),draft:q=>__post({draft:q}),act:(i,k)=>__post({act:i,key:k}),ready:()=>__post({ready:1})};document.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('[data-ask]');if(el){e.preventDefault();window.space.ask(el.getAttribute('data-ask'))}},true)</script>`;
  await p.setContent(read('artifact.html').replace(/<head[^>]*>/i, m => m + head));
  await p.waitForTimeout(400);
  const specs = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-open]')].map(e => e.getAttribute('data-open')))]);
  console.log('openable', specs.length, specs.join(' '));
  const report = [];
  for (const spec of specs) {
    await p.evaluate(s => document.querySelector(`[data-open="${s}"]`).click(), spec);
    await p.waitForTimeout(220);
    const r = await p.evaluate(() => ({ title: document.getElementById('sh-title').textContent, len: document.getElementById('sh-body').innerText.length, open: document.getElementById('sheet').classList.contains('on') }));
    report.push(`${spec} -> ${r.open ? 'open' : 'CLOSED'} "${r.title}" ${r.len} chars`);
    if (!r.open || r.len < 20) errors.push(`empty sheet ${spec}`);
    await p.screenshot({ path: path.join(out, `sheet-${spec.replace(/[:]/g, '_')}.png`) });
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  }
  console.log(report.join('\n'));
  // facts filter + search
  await p.evaluate(() => document.querySelector('[data-open="facts:chat"]').click()); await p.waitForTimeout(200);
  await p.fill('#fq', 'jack'); await p.waitForTimeout(150);
  console.log('search "jack":', await p.evaluate(() => document.querySelector('#flist .sh-sub').textContent));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // approve: confirm -> run
  const slot = await p.$('[data-approve]');
  if (slot) {
    await slot.click(); await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(out, 'approve-confirm.png') });
    await p.click('[data-go]'); await p.waitForTimeout(150);
    console.log('act posted:', JSON.stringify(posted.filter(m => m.act !== undefined)));
    await p.evaluate(() => window.postMessage({ type: 'hermes-space-jobs', jobs: [] }, '*'));
    const key = posted.find(m => m.act !== undefined)?.key;
    await p.evaluate(k => { const now = Date.now() / 1000; window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { type: 'hermes-space-jobs', jobs: [{ id: '1', key: k, state: 'running', steps: [{ label: 'Running a check' }], started_at: now - 130 }] } })) }, key);
    await p.waitForTimeout(150); await p.screenshot({ path: path.join(out, 'approve-running.png') });
    await p.evaluate(k => { const now = Date.now() / 1000; window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { type: 'hermes-space-jobs', jobs: [{ id: '1', key: k, state: 'done', steps: [{ label: 'a' }, { label: 'b' }], started_at: now - 900, finished_at: now, result: 'DONE: The latest backup restored cleanly into an isolated copy; 5,438 pages verified.\n- Restored 2.01 GB backup to a scratch folder\n- Page count and 5 known pages matched the live brain\n- Removed the scratch copy afterwards' }] } })) }, key);
    await p.waitForTimeout(150); await p.screenshot({ path: path.join(out, 'approve-done.png') });
    console.log('done card:', await p.evaluate(() => document.querySelector('.job')?.innerText.slice(0, 160)));
  }
  console.log('JS errors', JSON.stringify(errors));
  await b.close();
  process.exitCode = errors.length ? 1 : 0;
})();
