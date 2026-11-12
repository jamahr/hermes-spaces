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

Questions asked from the page arrive with a **Digest** of the current snapshot and your brief,
and render in a narrow panel beside the view.

1. If the digest answers it, answer straight away — don't re-read files the digest already
   covers. Otherwise read `data/latest.json` (and the tail of `data/history.jsonl` for
   trends). Ground every claim in those files or in a check you ran.
   Shape: **one bold verdict line**, ≤ 4 short evidence bullets, then the one action
   or "Nothing to do." Under 120 words unless he asks for depth.
2. Investigate read-only. Use the space's helpers (e.g.
   `python3 ~/.hermes/spaces/gbrain-health/gbrain_read.py TOOL '{json}'`),
   `systemctl status`, `journalctl -u <unit> -n 80 --no-pager`, log files.
3. Answer in chat, short: verdict first, then evidence, then the one action
   (or "nothing to do"). Say what you could not verify.
4. Do not repair, restart, re-schedule, or change files outside the space
   unless the user explicitly asks in this chat. A message starting "I approve:" sent from
   the space, or one marked "Approved by Andrew with the Approve button", is that explicit
   ask, for exactly the fix it names: back up what you change, apply it, verify it, report
   the result, and roll back if verification fails. Afterwards refresh the space's data and
   brief so the page shows the new state.

## Writing `brief.json`

```json
{"updated_at": "2026-11-11T09:45:00Z", "status": "warn",
 "decision": {"call": "act", "headline": "Approve one fix this week; your memory is safe meanwhile.",
              "cost_of_waiting": "Each night it fails, that day's chats don't become memory.",
              "effort": "about 10 minutes, one approval"},
 "headline": "Your brain is safe, but it has mostly stopped learning from your chats.",
 "summary": "Backups and search are fine. Learning worked 2 of 6 nights; a fix landed today.",
 "examined": "6 nightly runs, the job logs, 3 pipeline changes and 8 test questions",
 "items": [{"status": "warn", "title": "Learning from your chats worked 2 of 6 nights",
            "detail": "Two causes, both found: the AI service was blocked Nov 8 (fixed Nov 9) and the 15-minute limit cut Nov 10 short (raised to 60 today).",
            "do": "Nothing tonight; if tomorrow's run fails again, approve the fix below.",
            "fix_summary": "Split long chats so none exceeds the size limit",
            "effort": "10 min", "ask": "Why does learning from my chats keep failing?",
            "fix": "Propose the exact fix for nightly learning. Change nothing until I say go.",
            "approve": "I approve: split long chats so none exceeds the size limit. Apply it, verify it, and roll back if verification fails."}],
 "predictions": [{"night": "2026-11-11", "step": "facts", "expect": "ok",
                  "claim": "Learning will work tonight now the limit is 60 minutes"}]}
```

Brief rules (the view shows your decision and headline first; they are the most-read words you write):

- **Pre-investigate before you write.** For every flagged check, find the cause (read-only:
  logs, `latest.json.pipeline` changes, the scripts). Your brief states causes, not
  symptoms. "Cause not yet confirmed" only after you have actually looked, with what you checked.
- **`decision`** answers "do I need to act?": `call` is `act` (he must approve or do something this
  week), `watch` (something is changing; nothing for him yet) or `none`. Give the cost of waiting
  and the effort in his time, honestly.
- **Headline: ≤ 14 words, plain English**, the real story or the all-clear.
- **`summary`: at most 2 sentences, ≤ 35 words.** Detail belongs in items and in answers, not here.
- **`fix_summary` ≤ 6 words** (it is a button label). **`effort` is a concrete estimate of his time
  and the job's time**, e.g. "2 min to approve; runs ~20 min". Never "not yet measured": estimate.
- **Predict what you believe, not what is hoped.** If a known blocker remains, predict `fail` or
  say so in the claim.
- **Use the check labels' vocabulary.** Never write internal terms: dream cycle, orphan, ghost
  page, embedding, exit code, MCP, unattributed, write request, model route. Say "nightly
  upkeep", "unlinked pages", "search index", "the AI service".
- **Agree with the data.** `status` equals `latest.json` `status`. Numbers match the checks exactly.
- **Patterns, and shared causes, merge.** Failures with one root cause are ONE item. Read
  `latest.json.nights` for per-step results and `pipeline.changed_since_last_run` for fixes
  already made (say so; don't propose a fix that already landed).
- **`approve` is run verbatim when he presses Approve** (no chat in between). Make it a complete,
  self-contained instruction: what to do, where, how to verify, how to roll back, and what not to touch.
- `items`: only what needs him, worst first, **at most 3**: `title`, `detail` (cause),
  `do`, `ask`, `fix` (propose-only question) and, when you have a concrete fix,
  `fix_summary`, `effort` and `approve` (the exact instruction he would give to apply it,
  including verification and rollback).
- **`predictions`**: 1 to 3 checkable calls about the next nightly run: `night` (YYYY-MM-DD
  local), `step` (facts, import, maintenance, backup, offsite), `expect` (ok|fail) and a plain
  `claim`. The collector scores them and the view shows your track record. Predict honestly;
  calibration is the point.
- `examined`: one line on what you looked at, so he can trust the call at a glance.
- Nothing needs him → `decision.call: "none"`, `items: []`, a short all-clear headline.
- Write atomically (temp file + rename).

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
