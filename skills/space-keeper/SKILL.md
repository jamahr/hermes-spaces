---
name: space-keeper
description: "Use when you own a Hermes Space. Keep its view, brief, answers."
version: 0.1.0
author: jamahr
license: MIT
metadata:
  hermes:
    tags: [spaces, artifact, dashboard, monitoring]
---

# Space keeper

You own one or more **Spaces**. A space is you (the bot), a living view you
write (`artifact.html`), and the data a collector keeps fresh. The user opens it
from **Spaces** in the Hermes sidebar. Questions they ask from the space reach
your Bot Chat prefixed with `[<Space title> space]`.

## Files — `~/.hermes/spaces/<id>/`

| File | Owner | Purpose |
|---|---|---|
| `space.json` | user / setup | `title`, `question` (the decision this space answers), `bot`, `icon` |
| `data/latest.json` | collector | newest snapshot, incl. `checks[]` and `status` |
| `data/history.jsonl` | collector | one compact snapshot per line, oldest first |
| `brief.json` | **you** | your narrative: what matters now |
| `artifact.html` | **you** | the view |
| `versions/*.html` | **you** | previous views, `YYYYMMDDTHHMMSSZ.html` (UTC) |
| `collect.py`, helpers | setup | never edit unless the user asks |

Never write under `data/`. Never put secrets in any space file.

## Answering a space question

1. Read `space.json`, `data/latest.json`, and the tail of `data/history.jsonl`
   before answering. Ground every claim in those files or in a check you ran.
2. Investigate read-only. Use the space's helpers (e.g.
   `python3 ~/.hermes/spaces/gbrain-health/gbrain_read.py TOOL '{json}'`),
   `systemctl status`, `journalctl -u <unit> -n 80 --no-pager`, log files.
3. Answer in chat, short: verdict first, then evidence, then the one action
   (or "nothing to do"). Say what you could not verify.
4. Do not repair, restart, re-schedule, or change files outside the space
   unless the user explicitly asks in this chat.

## Writing `brief.json`

```json
{"updated_at": "2026-11-09T09:45:00Z", "status": "ok|warn|bad",
 "headline": "One sentence answering the space's question.",
 "summary": "Optional 1–2 sentences of context.",
 "items": [{"status": "bad", "title": "Nightly dream cycle failed",
            "detail": "Exit 1 at 4:04am; backup still ran.",
            "ask": "Why did last night's dream cycle fail, and is it fixed?"}]}
```

`items` are only things that need the user's attention, worst first, at most
5. Each `ask` is a full, self-contained question the user can click. Status
is your judgment, not just the worst check: a warn that is expected and
harmless is `ok` with a note. Write atomically (temp file + rename).

## Changing the view (`artifact.html`)

Only when the user asks, or when the data shape changed and the view breaks.

1. **Version first:** copy the current `artifact.html` to
   `versions/<UTC stamp>.html`. The user can restore any version from the
   space's history menu.
2. Write one self-contained HTML document. No external scripts, fonts, images
   or network requests. Under 1 MB.
3. **Data:** read `window.SPACE` = `{space, latest, history, brief}` — injected
   before your script runs. Never hard-code numbers from the data into the HTML.
4. **Theme:** use only the injected CSS variables — `--foreground`,
   `--muted-foreground`, `--faint-foreground`, `--accent`, `--border`, `--card`,
   `--surface`, `--ok`, `--warn`, `--bad`, `--blue`, `--purple`, `--font`.
   Background stays transparent.
5. **Ask-back:** any element with `data-ask="<full question>"` sends that
   question to you when clicked. In script: `space.ask(q)` sends,
   `space.draft(q)` pre-fills the user's composer without sending,
   `space.openChat()` opens your chat.
6. **Design to the question.** Lead with the answer to `space.json.question`
   (headline + what needs the user), then evidence. Every number should be
   clickable to ask about it. Prefer a few sharp visuals (bars, sparklines,
   status grid) over tables. Avoid red/green as the only signal: pair colour
   with words.
7. After writing, open the file and re-read it once for broken markup; tell
   the user what changed and that the previous view is in history.
