# Hermes Spaces

A **space** is a bot, a living artifact that bot writes and keeps up to date, and the data history behind it. It's like a Claude artifact that keeps itself current, with an agent you can ask about anything on the page.

- **Spaces** in the sidebar opens a hub. Each space opens a full page with its artifact.
- The artifact is a single self-contained HTML document written by the space's bot. It runs in the SDK's `SandboxedFrame` (opaque origin, scripts only), with the space's data and the app theme injected ahead of it.
- **Ask-back:** any element with `data-ask="…"` (or `space.ask(q)` in script) sends that question to the space's bot. It lands in the bot's canonical Bot Chat, which opens beside the space. The page also has an **Ask @bot** box.
- **Versions:** the bot versions the previous artifact before each rewrite, and the history menu restores any version (a restore is itself versioned).

## Space folder layout (on the backend host)

`~/.hermes/spaces/<id>/` (override with `HERMES_SPACES_ROOT`):

| File | Written by | Purpose |
|---|---|---|
| `space.json` | setup | `title`, `question` (the decision the space answers), `bot`, `icon`, `order` |
| `data/latest.json` | collector | newest snapshot (`checks[]`, `status`, …) |
| `data/history.jsonl` | collector | one compact snapshot per line |
| `brief.json` | bot | headline, status, items needing attention |
| `artifact.html` | bot | the view |
| `versions/*.html` | bot | earlier views |

Collectors are ordinary scripts run by Hermes cron (`--no-agent` for pure collection). Briefs come from a scheduled bot routine. The backend only reads these files, apart from the revert route. It never executes anything from a space folder.

The bundled `space-keeper` skill (`skills/space-keeper/`) teaches a bot the contract: data shape, theme variables, ask-back attributes, versioning, and "design to the question." Install it into the bot's profile.

## Install

**Backend** (on the machine running Hermes):

```sh
hermes plugins install jamahr/hermes-spaces --enable
```

**Mac / desktop app:** Capabilities → Plugins → **Install from Git** → `https://github.com/jamahr/hermes-spaces` → select **Desktop UI** (uncheck Agent plugin if the backend is already installed). Then enable **Spaces** in the Desktop UI column. The desktop half is opt-in.

Requires Hermes ≥ 0.21.5. Tested against renderer/backend v0.23.1.

## Verification

`tests/live-ui.cjs` is a development smoke test against the loopback Webapp. Last run: backend `/spaces` 200, hub rendered, artifact rendered with 8 checks, and an artifact click delivered its question to the bot's Bot Chat, which answered.

## Limits

- `ctx.socket` isn't used, so data refreshes by polling (30 s per space, 60 s for the hub).
- Ask-back opens the bot's chat as a stacked tab. If the composer isn't mounted in time, the question is copied to the clipboard and a toast explains.
- Native Mac install and the Hermex iPhone app have not been verified yet.
