// Hermes Spaces — desktop half.
//
// A space = a bot + a living artifact the bot writes + the data behind it.
// This file renders a Spaces hub and one page per space. The artifact (HTML the
// bot authored) runs inside the SDK's SandboxedFrame — opaque origin, scripts
// only — with the space's data and the app theme injected ahead of it. The
// artifact can ask the space's bot a question; the question lands in that bot's
// canonical Bot Chat, opened beside the space.
import {
  host, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA,
  Button, Input, Codicon, EmptyState, StatusDot, SandboxedFrame,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  useQuery, useQueryClient, useValue, useGatewayActivationEpoch
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-spaces'
const BASE = '/spaces'
const muted = 'text-(--ui-text-tertiary)'
const enc = encodeURIComponent
const fail = e => (e instanceof Error ? e.message : String(e))
const TONE = { ok: 'good', warn: 'warn', bad: 'bad' }
const STATUS_LABEL = { ok: 'Healthy', warn: 'Needs a look', bad: 'Needs you' }

let CTX = null
const rest = (path, opts) => CTX.rest(path, opts)

function routeSpace() {
  const hash = window.location.hash.slice(1)
  const q = hash.indexOf('?')
  return q < 0 ? '' : (new URLSearchParams(hash.slice(q + 1)).get('space') || '').slice(0, 48)
}
const go = id => host.navigate(id ? `${BASE}?space=${enc(id)}` : BASE)

function timeAgo(sec) {
  if (!sec) return 'never'
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(sec)))
  if (s < 60) return 'just now'
  const [n, u] = s < 3600 ? [Math.floor(s / 60), 'min'] : s < 86400 ? [Math.floor(s / 3600), 'h'] : [Math.floor(s / 86400), 'd']
  return `${n}${u === 'min' ? ' min' : u} ago`
}

// ---- asking the space's bot ------------------------------------------------

async function botChatId(bot) {
  const res = await host.request('profiles.list', {})
  const rows = res?.profiles || res?.rows || (Array.isArray(res) ? res : [])
  const row = rows.find(r => r.name === bot)
  if (!row) throw new Error(`Bot "${bot}" not found on this backend`)
  const c = row.canonical_session
  return c ? c.resolved_id || c.id : null
}

async function askBot(space, prompt, { send = true } = {}) {
  const text = String(prompt || '').trim().slice(0, 1500)
  const bot = space.bot
  if (!bot) { host.notify({ kind: 'warning', message: 'This space has no bot assigned' }); return false }
  const framed = text ? `[${space.title} space] ${text}` : ''
  try {
    const sid = await botChatId(bot)
    if (!sid) {
      // No Bot Chat yet: open a fresh chat on that bot and seed the draft.
      host.newChat(bot)
      if (framed) await retry(() => host.composer.setDraft('new', framed))
      return true
    }
    await host.openSession(sid, { profile: bot, intent: 'stack' })
    if (!framed) return true
    const ok = await retry(() => (send ? host.composer.submit(sid, framed) : host.composer.setDraft(sid, framed)))
    if (!ok) {
      host.notify({ kind: 'warning', message: `Opened ${bot}'s chat, but its composer did not take the question — paste it there.` })
      CTX?.os?.writeClipboard?.(framed)
    }
    return ok
  } catch (e) {
    host.notifyError ? host.notifyError(e, 'Could not reach the bot') : host.notify({ kind: 'error', message: fail(e) })
    return false
  }
}

async function retry(fn, tries = 25, wait = 250) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true } catch { /* composer not mounted yet */ }
    await new Promise(r => setTimeout(r, wait))
  }
  return false
}

// ---- artifact document -----------------------------------------------------

const THEME_VARS = {
  '--foreground': ['--ui-text-primary'],
  '--muted-foreground': ['--ui-text-tertiary', '--ui-text-secondary'],
  '--faint-foreground': ['--ui-text-quaternary'],
  '--accent': ['--ui-accent'],
  '--border': ['--ui-stroke-secondary', '--ui-stroke-tertiary'],
  '--card': ['--ui-bg-elevated', '--ui-widget-surface-background', '--ui-bg-tertiary'],
  '--surface': ['--ui-bg-tertiary', '--ui-bg-quaternary'],
  '--ok': ['--ui-green', '--ui-success'],
  '--warn': ['--ui-yellow', '--ui-orange'],
  '--bad': ['--ui-red'],
  '--blue': ['--ui-blue'],
  '--purple': ['--ui-purple']
}

function themeCss() {
  const cs = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const lines = []
  for (const [name, sources] of Object.entries(THEME_VARS)) {
    for (const src of sources) {
      const v = cs.getPropertyValue(src).trim()
      if (v) { lines.push(`${name}:${v}`); break }
    }
  }
  lines.push(`--font:${body.fontFamily || 'system-ui, sans-serif'}`)
  const scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return `:root{${lines.join(';')};color-scheme:${scheme}}html,body{margin:0;background:transparent;color:var(--foreground);font-family:var(--font)}`
}

// Runs inside the frame before the artifact. Defines window.SPACE (data) and
// window.space.ask(prompt); routes [data-hermes-send] / [data-ask] clicks to ask.
const BRIDGE = `(()=>{let last=0;function ask(p){p=String(p||'').trim();if(!p)return false;const n=Date.now();if(n-last<800)return false;last=n;parent.postMessage({type:'hermes-space-ask',prompt:p.slice(0,1500)},'*');return true}
function draft(p){parent.postMessage({type:'hermes-space-draft',prompt:String(p||'').slice(0,1500)},'*')}
window.space={ask,draft,openChat:()=>parent.postMessage({type:'hermes-space-open'},'*')};window.hermes=window.hermes||{send:p=>Promise.resolve(ask(p)?{ok:true}:{ok:false,error:'throttled'})};
document.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('[data-hermes-send],[data-ask]');if(el){e.preventDefault();ask(el.getAttribute('data-hermes-send')||el.getAttribute('data-ask'))}},true);})();`

function b64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function buildDoc(artifact, data, space) {
  const payload = JSON.stringify({ space: { id: space.id, title: space.title, question: space.question, bot: space.bot }, ...data })
    .replace(/</g, '\\u003c')
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeCss()}</style><script>window.SPACE=${payload};${BRIDGE}</script>`
  const html = /<head[^>]*>/i.test(artifact)
    ? artifact.replace(/<head[^>]*>/i, m => m + head)
    : `<!doctype html><html><head>${head}</head><body>${artifact}</body></html>`
  return `data:text/html;charset=utf-8;base64,${b64(html)}`
}

// ---- views -----------------------------------------------------------------

function useSpaces() {
  const epoch = useGatewayActivationEpoch()
  const profile = useValue(host.state.profile)
  return useQuery({ queryKey: [ID, epoch, profile, 'list'], queryFn: () => rest('/spaces'), refetchInterval: 60000 })
}

function App() {
  const [id, setId] = useState(routeSpace)
  useEffect(() => {
    const fn = () => setId(routeSpace())
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return id ? jsx(SpacePage, { id, key: id }) : jsx(Hub, {})
}

function Hub() {
  const list = useSpaces()
  if (list.isLoading) return jsx(EmptyState, { title: 'Loading spaces…' })
  if (list.error) return jsx(EmptyState, { title: 'Spaces unavailable', description: `${fail(list.error)}. Is the hermes-spaces backend enabled on this server?` })
  const spaces = list.data?.spaces || []
  return jsxs('div', {
    className: 'mx-auto w-full max-w-4xl p-8',
    children: [
      jsx('h1', { className: 'text-xl font-semibold', children: 'Spaces' }),
      jsx('p', { className: `${muted} mt-1 text-sm`, children: 'Each space is a bot, the view it keeps up to date, and the history behind it. Ask a space anything — the question goes to its bot.' }),
      spaces.length === 0
        ? jsx(EmptyState, { title: 'No spaces yet', description: 'Ask Hermes to build one.' })
        : jsx('div', {
          className: 'mt-6 grid gap-3', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' },
          children: spaces.map(s => jsxs('button', {
            type: 'button', onClick: () => go(s.id),
            className: 'rounded-lg border border-(--ui-stroke-secondary) p-4 text-left hover:bg-(--ui-row-hover-background)',
            children: [
              jsxs('div', { className: 'flex items-center gap-2', children: [jsx(Codicon, { name: s.icon || 'layout' }), jsx('span', { className: 'font-medium', children: s.title }), jsx('span', { className: 'ml-auto', children: s.status && jsx(StatusDot, { tone: TONE[s.status] || 'muted' }) })] }),
              jsx('div', { className: `${muted} mt-2 text-xs`, children: s.headline || s.question }),
              jsx('div', { className: `${muted} mt-3 text-[11px]`, children: `${s.bot ? `@${s.bot} · ` : ''}data ${timeAgo(s.data_updated_at)}` })
            ]
          }))
        })
    ]
  })
}

function SpacePage({ id }) {
  const qc = useQueryClient()
  const epoch = useGatewayActivationEpoch()
  const profile = useValue(host.state.profile)
  const q = useQuery({ queryKey: [ID, epoch, profile, 'space', id], queryFn: () => rest(`/spaces/${enc(id)}`), refetchInterval: 30000 })
  const frame = useRef(null)
  const [question, setQuestion] = useState('')
  const space = q.data?.space
  const signature = q.data ? `${space?.artifact_updated_at}|${space?.data_updated_at}|${space?.brief_updated_at}` : ''
  // Rebuild the document only when the artifact or its data changed, so a poll
  // doesn't reset the artifact's scroll/state.
  const src = useMemo(() => (q.data?.artifact ? buildDoc(q.data.artifact, q.data.data, space) : null), [signature])

  useEffect(() => {
    if (!space) return undefined
    const onMsg = e => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data || {}
      if (d.type === 'hermes-space-ask') askBot(space, d.prompt)
      else if (d.type === 'hermes-space-draft') askBot(space, d.prompt, { send: false })
      else if (d.type === 'hermes-space-open') askBot(space, '')
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [space?.id, space?.bot])

  if (q.isLoading) return jsx(EmptyState, { title: 'Loading space…' })
  if (q.error) return jsx(EmptyState, { title: 'Space unavailable', description: fail(q.error) })

  const submit = async () => { if (question.trim() && (await askBot(space, question))) setQuestion('') }
  const status = space.status

  return jsxs('div', {
    className: 'flex h-full min-h-0 w-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-tertiary) px-4 py-2',
        children: [
          jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => go(), title: 'All spaces', children: jsx(Codicon, { name: 'arrow-left' }) }),
          jsx(Codicon, { name: space.icon || 'layout' }),
          jsx('span', { className: 'font-medium', children: space.title }),
          status && jsxs('span', { className: `${muted} flex items-center gap-1 text-xs`, children: [jsx(StatusDot, { tone: TONE[status] || 'muted' }), STATUS_LABEL[status] || status] }),
          jsx('span', { className: `${muted} text-xs`, title: space.question, children: `· data ${timeAgo(space.data_updated_at)}` }),
          jsxs('div', {
            className: 'ml-auto flex min-w-[280px] flex-1 items-center gap-2', style: { maxWidth: 560 },
            children: [
              jsx(Input, { value: question, placeholder: `Ask ${space.bot ? '@' + space.bot : 'this space'}…`, onChange: e => setQuestion(e.target.value), onKeyDown: e => { if (e.key === 'Enter') submit() } }),
              jsx(Button, { size: 'sm', onClick: submit, disabled: !question.trim(), children: 'Ask' }),
              jsx(Button, { variant: 'ghost', size: 'sm', title: `Open ${space.bot}'s chat`, onClick: () => askBot(space, ''), children: jsx(Codicon, { name: 'comment-discussion' }) }),
              jsx(Versions, { space, onDone: () => qc.invalidateQueries({ queryKey: [ID] }) }),
              jsx(Button, { variant: 'ghost', size: 'sm', title: 'Refresh', onClick: () => qc.invalidateQueries({ queryKey: [ID] }), children: jsx(Codicon, { name: 'refresh' }) })
            ]
          })
        ]
      }),
      src
        ? jsx(SandboxedFrame, { ref: frame, src, title: `${space.title} space`, className: 'min-h-0 w-full flex-1 border-0', style: { background: 'transparent' } })
        : jsx(EmptyState, { title: 'No view yet', description: `Ask ${space.bot || 'the bot'} to build this space's view.` })
    ]
  })
}

function Versions({ space, onDone }) {
  const [open, setOpen] = useState(false)
  const v = useQuery({ queryKey: [ID, 'versions', space.id, open], queryFn: () => rest(`/spaces/${enc(space.id)}/versions`), enabled: open })
  const revert = async name => {
    try {
      await rest(`/spaces/${enc(space.id)}/revert`, { method: 'POST', body: { version: name } })
      host.notify({ kind: 'success', message: `Restored the ${name.slice(0, 15)} view` })
      onDone()
    } catch (e) { host.notify({ kind: 'error', message: fail(e) }) }
  }
  const rows = v.data?.versions || []
  return jsxs(DropdownMenu, {
    open, onOpenChange: setOpen,
    children: [
      jsx(DropdownMenuTrigger, { asChild: true, children: jsx(Button, { variant: 'ghost', size: 'sm', title: 'Earlier versions of this view', children: jsx(Codicon, { name: 'history' }) }) }),
      jsx(DropdownMenuContent, {
        align: 'end',
        children: rows.length
          ? rows.slice(0, 20).map(r => jsx(DropdownMenuItem, { onSelect: () => revert(r.name), children: `Restore ${r.name.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d).*/, '$1-$2-$3 $4:$5 UTC')}` }))
          : jsx(DropdownMenuItem, { disabled: true, children: v.isLoading ? 'Loading…' : 'No earlier versions' })
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Spaces',
  register(ctx) {
    CTX = ctx
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: BASE }, render: () => jsx(App, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: BASE, label: 'Spaces', codicon: 'layout' } })
    ctx.register({ id: 'open', area: PALETTE_AREA, data: { id: 'hermes-spaces.open', label: 'Open Spaces', keywords: ['spaces', 'dashboard'], run: () => go() } })
  }
}
