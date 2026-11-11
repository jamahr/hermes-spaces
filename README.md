# Hermes Spaces

A **space** is a bot, a living artifact that the bot writes and keeps up to date, and the data history behind it. Think of a Claude artifact that keeps itself current, with an agent beside it that you can ask about anything on the page.

Spaces are built to answer one decision, not to dump data. Each space opens with a **call** (*act this week*, *watching*, or *nothing needs you*). The call states the cost of waiting and how much of your time a fix takes, and has an **Approve** button for the fix the bot has already diagnosed.

## What you get

- **Spaces** in the sidebar opens a hub. Each space opens a full page with its artifact and an **Ask panel** beside it.
- **Click anything to ask.** Any element with `data-ask="…"` (or `space.ask(q)` in script) sends that question to the space's bot. The answer streams into the panel and lists what the bot checked: a bold verdict, a few bullets, then **Do:**. Answers run in a conversation dedicated to the space, so alerts in the bot's inbox stay clean. You can follow up, start a new thread, or open it as a full chat.
- **Approve, safely.** `data-draft` / `space.draft(text)` puts an approval into the Ask box and nothing runs until you press Ask. The bundled skill limits an approval to exactly the fix it names, and the bot must back up, verify, and roll back if verification fails.
- **Since you looked.** The page knows when you last opened it and shows what changed since then.
- **Forecasts with a track record.** The bot predicts the next run (`brief.json.predictions`), the collector scores each call against what actually happened, and the page shows how many forecasts were right.
- **Versions.** The bot archives the previous artifact before each rewrite, and the history menu restores any version (restores are versioned too).
- **Suggested questions** come from `space.json.suggestions`.

The artifact is a single self-contained HTML document. It runs in the SDK's `SandboxedFrame` (opaque origin, scripts only), with the space's data, the app theme, and the viewer's last visit injected ahead of it.

## Space folder layout (on the backend host)

`~/.hermes/spaces/<id>/` (override with `HERMES_SPACES_ROOT`):

| File | Written by | Purpose |
|---|---|---|
| `space.json` | setup | `title`, `question` (the decision the space answers), `bot`, `icon`, `order`, `suggestions` |
| `data/latest.json` | collector | newest snapshot (`checks[]` with `ok`/`watch`/`warn`/`bad`, `status`, …) |
| `data/history.jsonl` | collector | one compact snapshot per line |
| `brief.json` | bot | `decision`, headline, items (cause, fix, approve), predictions |
| `artifact.html` | bot | the view |
| `versions/*.html` | bot | earlier views |
| `asks/` | backend | the space's ask thread and streamed answers |

Collectors are ordinary scripts run by Hermes cron (`--no-agent` for pure collection), and briefs come from a scheduled bot routine. The backend reads these files and writes only `asks/` and reverts. It never executes anything from a space folder.

The bundled `space-keeper` skill (`skills/space-keeper/`) teaches a bot the contract: the data shape, theme variables, ask and draft attributes, brief rules (pre-diagnose causes, merge shared causes, honest effort, checkable predictions), versioning, and "design to the decision." Install it into the bot's profile.

## Install

**Backend** (on the machine running Hermes):

```sh
hermes plugins install jamahr/hermes-spaces --enable
```

Restart the gateway after updating, because plugin API routes mount at startup.

**Mac / desktop app:** Capabilities → Plugins → **Install from Git** → `https://github.com/jamahr/hermes-spaces` → select **Desktop UI** (uncheck Agent plugin if the backend is already installed). Then switch on **Spaces** in the Desktop UI column. The desktop half is opt-in.

Requires Hermes ≥ 0.21.5. Tested against renderer/backend v0.23.1.

## Tests

- `tests/render-artifact.cjs <space-dir> <out>` renders an artifact standalone in light and dark at 390, 820, and 1180 px. It fails on JS errors and flags horizontal overflow.
- `tests/live-ui.cjs` runs end to end in the loopback Webapp: hub → space → click a failed square → the question appears in the Ask panel → the bot's answer streams in → a typed follow-up gets an answer in the same thread. Set `SIDE=<port>` with `tests/side_backend.py` to exercise backend changes before a gateway restart. Last run: both answers completed (11 s and 6 s) with no JS errors.

## Limits

- `ctx.socket` isn't used, so data refreshes by polling (30 s per space, 1 s while an answer streams).
- One ask runs at a time per space.
- Native Mac install and the Hermex iPhone app have not been verified yet.
