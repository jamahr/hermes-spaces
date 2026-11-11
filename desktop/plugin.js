// Hermes Spaces — desktop half.
//
// A space = a bot + a living artifact the bot writes + the data behind it.
// The artifact (bot-authored HTML) runs inside the SDK's SandboxedFrame — opaque origin,
// scripts only — with the space's data, the app theme and "when you last looked" injected
// ahead of it. Anything in the artifact can ask the space's bot a question; the answer
// streams into an Ask panel beside the view (a conversation dedicated to the space, run by
// the plugin backend), so the user never leaves the page.
import {
  host, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA,
  Button, Textarea, Codicon, EmptyState, StatusDot, SandboxedFrame, MessageTextContent,
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
const STATUS_LABEL = { ok: 'All clear', warn: 'Needs a look', bad: 'Needs you' }
const SEEN_GAP_S = 3600 // a revisit within an hour doesn't reset "since you looked"
const LIVE = ['queued', 'investigating', 'answering']

let CTX = null
const rest = (path, opts) => CTX.rest(path, opts)
const store = {
  get: async (k, d = null) => { try { const v = CTX.storage.get(k, d); return (v && typeof v.then === 'function' ? await v : v) ?? d } catch { return d } },
  set: async (k, v) => { try { await CTX.storage.set(k, v) } catch { /* storage unavailable */ } }
}

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
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
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
  '--warn': ['--ui-orange', '--ui-yellow'],
  '--bad': ['--ui-red'],
  '--blue': ['--ui-blue'],
  '--purple': ['--ui-purple']
}

function themeCss() {
  const cs = getComputedStyle(document.documentElement)
  const lines = []
  for (const [name, sources] of Object.entries(THEME_VARS)) {
    for (const src of sources) {
      const v = cs.getPropertyValue(src).trim()
      if (v) { lines.push(`${name}:${v}`); break }
    }
  }
  lines.push(`--font:${getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'}`)
  const scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return `:root{${lines.join(';')};color-scheme:${scheme}}html,body{margin:0;background:transparent;color:var(--foreground);font-family:var(--font)}`
}

// Runs inside the frame before the artifact: window.space.ask/draft/openChat, and
// [data-ask] / [data-hermes-send] click routing.
const BRIDGE = `(()=>{let last=0;function ask(p,c){p=String(p||'').trim();if(!p)return false;const n=Date.now();if(n-last<700)return false;last=n;parent.postMessage({type:'hermes-space-ask',prompt:p.slice(0,1500),context:String(c||'').slice(0,500)},'*');return true}
function draft(p){parent.postMessage({type:'hermes-space-draft',prompt:String(p||'').slice(0,1500)},'*')}
window.space={ask,draft,openChat:()=>parent.postMessage({type:'hermes-space-open'},'*')};window.hermes=window.hermes||{send:p=>Promise.resolve(ask(p)?{ok:true}:{ok:false,error:'throttled'})};
document.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('[data-hermes-send],[data-ask]');if(el){e.preventDefault();e.stopPropagation();ask(el.getAttribute('data-hermes-send')||el.getAttribute('data-ask'),el.getAttribute('data-context')||'')}},true);})();`

function b64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function buildDoc(artifact, data, space, viewer) {
  const payload = JSON.stringify({ space: { id: space.id, title: space.title, question: space.question, bot: space.bot }, ...data, viewer: viewer || {} })
    .replace(/</g, '\\u003c')
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeCss()}</style><script>window.SPACE=${payload};${BRIDGE}</script>`
  const html = /<head[^>]*>/i.test(artifact)
    ? artifact.replace(/<head[^>]*>/i, m => m + head)
    : `<!doctype html><html><head>${head}</head><body>${artifact}</body></html>`
  return `data:text/html;charset=utf-8;base64,${b64(html)}`
}

// "Since you looked": keep the previous visit (at least an hour old) and the current one.
async function loadViewer(id, history) {
  const key = `seen:${id}`
  const rec = (await store.get(key, null)) || {}
  const nowS = Date.now() / 1000
  const snap = history && history.length ? history[history.length - 1] : null
  let prev = rec.prev || null
  if (rec.cur && nowS - rec.cur.at > SEEN_GAP_S) prev = rec.cur
  await store.set(key, { prev, cur: { at: nowS, snap } })
  return prev ? { last_seen_at: new Date(prev.at * 1000).toISOString(), last: prev.snap } : {}
}

// ---- views -----------------------------------------------------------------

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
  const epoch = useGatewayActivationEpoch()
  const profile = useValue(host.state.profile)
  const list = useQuery({ queryKey: [ID, epoch, profile, 'list'], queryFn: () => rest('/spaces'), refetchInterval: 60000 })
  if (list.isLoading) return jsx(EmptyState, { title: 'Loading spaces…' })
  if (list.error) return jsx(EmptyState, { title: 'Spaces unavailable', description: `${fail(list.error)}. Is the Spaces backend enabled on this server?` })
  const spaces = list.data?.spaces || []
  return jsxs('div', {
    className: 'w-full max-w-5xl p-8',
    children: [
      jsx('h1', { className: 'text-xl font-semibold', children: 'Spaces' }),
      jsx('p', { className: `${muted} mt-1 text-sm`, children: 'Living views your bots keep current. Click anything in a space to ask about it.' }),
      spaces.length === 0
        ? jsx(EmptyState, { title: 'No spaces yet', description: 'Ask Hermes to build one.' })
        : jsx('div', {
          className: 'mt-6 grid gap-3', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' },
          children: spaces.map(s => jsxs('button', {
            type: 'button', onClick: () => go(s.id),
            className: 'rounded-xl border border-(--ui-stroke-secondary) p-4 text-left hover:border-(--ui-accent)',
            children: [
              jsxs('div', { className: 'flex items-center gap-2 text-sm', children: [jsx(Codicon, { name: s.icon || 'layout' }), jsx('span', { className: 'font-medium', children: s.title }),
                s.status && jsxs('span', { className: `${muted} ml-auto flex items-center gap-1 text-xs`, children: [jsx(StatusDot, { tone: TONE[s.status] || 'muted' }), STATUS_LABEL[s.status] || s.status] })] }),
              jsx('div', { className: 'mt-2 text-[13px] leading-snug', children: s.headline || s.question }),
              jsx('div', { className: `${muted} mt-3 text-[11px]`, children: `${s.bot ? `@${s.bot} · ` : ''}updated ${timeAgo(s.data_updated_at)}` })
            ]
          }, s.id))
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
  const [viewer, setViewer] = useState(null)
  const [panel, setPanel] = useState(false)
  const [pending, setPending] = useState(null)
  const space = q.data?.space

  useEffect(() => { store.get(`panel:${id}`, true).then(v => setPanel(v !== false)) }, [id])
  const togglePanel = open => { setPanel(open); store.set(`panel:${id}`, open) }
  useEffect(() => { if (q.data && viewer === null) loadViewer(id, q.data.data?.history).then(setViewer) }, [!!q.data])

  // Rebuild the document only when the artifact or its data changed, so polling
  // doesn't reset the artifact's scroll position or state.
  const signature = q.data && viewer !== null ? `${space?.artifact_updated_at}|${space?.data_updated_at}|${space?.brief_updated_at}` : ''
  const src = useMemo(() => (q.data?.artifact && viewer !== null ? buildDoc(q.data.artifact, q.data.data, space, viewer) : null), [signature])

  useEffect(() => {
    if (!space) return undefined
    const onMsg = e => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data || {}
      if (d.type === 'hermes-space-ask') { togglePanel(true); setPending({ question: d.prompt, context: d.context || '', send: true, n: Date.now() }) }
      else if (d.type === 'hermes-space-draft') { togglePanel(true); setPending({ question: d.prompt, send: false, n: Date.now() }) }
      else if (d.type === 'hermes-space-open') togglePanel(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [space?.id])

  if (q.isLoading) return jsx(EmptyState, { title: 'Loading space…' })
  if (q.error) return jsx(EmptyState, { title: 'Space unavailable', description: fail(q.error) })
  const status = space.status

  return jsxs('div', {
    className: 'flex h-full min-h-0 w-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-1.5',
        children: [
          jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => go(), title: 'All spaces', children: jsx(Codicon, { name: 'arrow-left' }) }),
          jsx('span', { className: 'text-sm font-medium', children: space.title }),
          status && jsxs('span', { className: `${muted} flex items-center gap-1 text-xs`, children: [jsx(StatusDot, { tone: TONE[status] || 'muted' }), STATUS_LABEL[status] || status] }),
          jsx('span', { className: `${muted} text-xs`, children: `· updated ${timeAgo(space.data_updated_at)}` }),
          jsxs('div', {
            className: 'ml-auto flex items-center gap-1',
            children: [
              jsx(Versions, { space, onDone: () => qc.invalidateQueries({ queryKey: [ID] }) }),
              jsx(Button, { variant: 'ghost', size: 'sm', title: 'Refresh', onClick: () => qc.invalidateQueries({ queryKey: [ID] }), children: jsx(Codicon, { name: 'refresh' }) }),
              jsxs(Button, {
                variant: panel ? 'secondary' : 'ghost', size: 'sm', title: panel ? 'Hide the Ask panel' : `Ask @${space.bot}`, onClick: () => togglePanel(!panel),
                children: [jsx(Codicon, { name: 'comment-discussion' }), jsx('span', { className: 'ml-1 text-xs', children: `Ask @${space.bot}` })]
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex min-h-0 flex-1',
        children: [
          src
            ? jsx(SandboxedFrame, { ref: frame, src, title: `${space.title} space`, className: 'min-h-0 min-w-0 flex-1 border-0', style: { background: 'transparent' } })
            : jsx('div', { className: 'flex-1', children: jsx(EmptyState, { title: viewer === null ? 'Loading…' : 'No view yet', description: viewer === null ? '' : `Ask @${space.bot || 'the bot'} to build this space's view.` }) }),
          panel && jsx(AskPanel, { space, pending, onClose: () => togglePanel(false) })
        ]
      })
    ]
  })
}

// ---- the Ask panel ---------------------------------------------------------

function AskPanel({ space, pending, onClose }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const scroller = useRef(null)
  const lastPending = useRef(0)
  const asks = useQuery({
    queryKey: [ID, 'asks', space.id],
    queryFn: () => rest(`/spaces/${enc(space.id)}/asks?limit=30`),
    refetchInterval: query => {
      const d = query?.state?.data
      return d && (d.running || (d.asks || []).some(r => LIVE.includes(r.state))) ? 1000 : 15000
    }
  })
  const rows = asks.data?.asks || []
  const running = !!asks.data?.running || rows.some(r => LIVE.includes(r.state))
  const suggestions = space.suggestions || []

  const send = async (question, context = '', newThread = false) => {
    const qtext = String(question || '').trim()
    if (!qtext || sending) return false
    if (running) { host.notify({ kind: 'info', message: `@${space.bot} is still answering. Ask again in a moment.` }); return false }
    setSending(true)
    try {
      await rest(`/spaces/${enc(space.id)}/ask`, { method: 'POST', body: { question: qtext, context, new_thread: newThread } })
      await qc.invalidateQueries({ queryKey: [ID, 'asks', space.id] })
      return true
    } catch (e) {
      host.notify({ kind: 'warning', message: `Could not ask @${space.bot}: ${fail(e)}` })
      return false
    } finally { setSending(false) }
  }

  useEffect(() => {
    if (!pending || pending.n === lastPending.current) return
    lastPending.current = pending.n
    if (pending.send) send(pending.question, pending.context)
    else setText(pending.question)
  }, [pending?.n])

  const last = rows[rows.length - 1]
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [rows.length, last?.answer?.length, last?.steps?.length, last?.state])

  const submit = async () => { if (await send(text)) setText('') }
  const openChat = () => {
    const sid = asks.data?.thread_session
    if (sid) Promise.resolve(host.openSession(sid, { profile: space.bot, intent: 'tab' })).catch(e => host.notify({ kind: 'error', message: fail(e) }))
  }

  return jsxs('aside', {
    className: 'flex min-h-0 flex-col border-l border-(--ui-stroke-tertiary)',
    style: { width: 380, minWidth: 300, maxWidth: '45%' },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1 px-3 py-2',
        children: [
          jsx('span', { className: 'text-sm font-medium', children: `Ask @${space.bot}` }),
          jsxs('div', {
            className: 'ml-auto flex items-center',
            children: [
              jsx(Button, { variant: 'ghost', size: 'sm', title: 'New conversation', disabled: running || !rows.length, onClick: () => send(suggestions[0] || 'How is it looking right now?', '', true), children: jsx(Codicon, { name: 'add' }) }),
              jsx(Button, { variant: 'ghost', size: 'sm', title: 'Open as a full chat', disabled: !asks.data?.thread_session, onClick: openChat, children: jsx(Codicon, { name: 'link-external' }) }),
              jsx(Button, { variant: 'ghost', size: 'sm', title: 'Close', onClick: onClose, children: jsx(Codicon, { name: 'close' }) })
            ]
          })
        ]
      }),
      jsxs('div', {
        ref: scroller, className: 'min-h-0 flex-1 overflow-y-auto px-3 pb-3',
        children: [
          !rows.length && jsxs('div', {
            className: 'pt-1',
            children: [
              jsx('div', { className: `${muted} text-[13px]`, children: `Click anything in the view, or ask @${space.bot} here. Every answer shows what it checked.` }),
              jsx(Suggestions, { items: suggestions, onPick: s => send(s), disabled: running })
            ]
          }),
          ...rows.map(r => jsx(AskItem, { r, bot: space.bot, onRetry: () => send(r.question, r.context) }, r.id)),
          rows.length > 0 && !running && jsx(Suggestions, { items: suggestions.filter(s => !rows.some(r => r.question === s)).slice(0, 3), onPick: s => send(s), disabled: running, compact: true })
        ]
      }),
      jsxs('div', {
        className: 'border-t border-(--ui-stroke-tertiary) p-2',
        children: [
          jsx(Textarea, {
            value: text, rows: 2, placeholder: running ? `@${space.bot} is answering…` : 'Ask about anything on this page',
            onChange: e => setText(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } },
            className: 'resize-none text-[13px]'
          }),
          jsxs('div', {
            className: 'mt-1 flex items-center gap-2',
            children: [
              jsx('span', { className: `${muted} text-[11px] leading-tight`, children: 'Investigates and proposes. Changes nothing until you say go.' }),
              jsx(Button, { className: 'ml-auto', size: 'sm', disabled: !text.trim() || running || sending, onClick: submit, children: 'Ask' })
            ]
          })
        ]
      })
    ]
  })
}

function Suggestions({ items, onPick, disabled, compact }) {
  if (!items || !items.length) return null
  return jsx('div', {
    className: `${compact ? 'mt-3' : 'mt-4'} flex flex-wrap gap-1.5`,
    children: items.map(s => jsx('button', {
      type: 'button', disabled, onClick: () => onPick(s),
      className: 'rounded-full border border-(--ui-stroke-secondary) px-2.5 py-1 text-left text-[12px] hover:border-(--ui-accent) disabled:opacity-50',
      children: s
    }, s))
  })
}

function AskItem({ r, bot, onRetry }) {
  const live = LIVE.includes(r.state)
  const [showSteps, setShowSteps] = useState(false)
  const steps = r.steps || []
  const secs = r.finished_at ? Math.round(r.finished_at - r.asked_at) : null
  return jsxs('div', {
    className: 'mt-4',
    children: [
      jsx('div', { className: 'ml-8 rounded-xl bg-(--ui-chat-bubble-background) px-3 py-2 text-[13px]', children: r.question }),
      jsxs('div', {
        className: 'mt-2',
        children: [
          jsxs('button', {
            type: 'button', onClick: () => setShowSteps(!showSteps), disabled: live || !steps.length,
            className: `${muted} flex items-center gap-1 text-[11.5px]`,
            children: [
              jsx(Codicon, { name: live ? 'loading~spin' : (steps.length ? (showSteps ? 'chevron-down' : 'chevron-right') : 'check') }),
              live
                ? (steps.length ? `${steps[steps.length - 1].label}…` : `@${bot} is reading the page…`)
                : (steps.length ? `Checked ${steps.length} thing${steps.length > 1 ? 's' : ''}` : 'Answered from the page data') + (secs != null ? ` · ${secs}s` : '')
            ]
          }),
          showSteps && !live && jsx('ul', {
            className: `${muted} mt-1 ml-4 space-y-0.5 text-[11.5px]`,
            children: steps.map((s, i) => jsxs('li', { className: 'flex items-center gap-1', children: [jsx(Codicon, { name: 'check' }), s.label] }, i))
          }),
          r.answer && jsx('div', { className: 'mt-1.5 text-[13px] leading-relaxed', children: jsx(MessageTextContent, { text: r.answer, media: false }) }),
          r.state === 'error' && jsxs('div', {
            className: 'mt-1 text-[12px] text-(--ui-red)',
            children: [`Couldn't finish: ${r.error || 'unknown error'}. `, jsx('button', { type: 'button', className: 'underline', onClick: onRetry, children: 'Try again' })]
          })
        ]
      })
    ]
  })
}

function Versions({ space, onDone }) {
  const [open, setOpen] = useState(false)
  const v = useQuery({ queryKey: [ID, 'versions', space.id, open], queryFn: () => rest(`/spaces/${enc(space.id)}/versions`), enabled: open })
  const revert = async name => {
    try {
      await rest(`/spaces/${enc(space.id)}/revert`, { method: 'POST', body: { version: name } })
      host.notify({ kind: 'success', message: 'Restored that version. The one it replaced is in history too.' })
      onDone()
    } catch (e) { host.notify({ kind: 'error', message: fail(e) }) }
  }
  const rows = v.data?.versions || []
  const label = n => { const m = n.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : n }
  return jsxs(DropdownMenu, {
    open, onOpenChange: setOpen,
    children: [
      jsx(DropdownMenuTrigger, { asChild: true, children: jsx(Button, { variant: 'ghost', size: 'sm', title: 'Earlier versions of this view', children: jsx(Codicon, { name: 'history' }) }) }),
      jsx(DropdownMenuContent, {
        align: 'end',
        children: rows.length
          ? rows.slice(0, 20).map(r => jsx(DropdownMenuItem, { onSelect: () => revert(r.name), children: `Restore the view from ${label(r.name)}` }, r.name))
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
