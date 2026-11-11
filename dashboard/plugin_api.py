"""Hermes Spaces backend, mounted by Hermes at ``/api/plugins/hermes-spaces/``.

A *space* is a folder under the spaces root (default ``~/.hermes/spaces/<id>/``):

    space.json        meta: id, title, question, bot, icon, order
    artifact.html     the current bot-authored view (one self-contained HTML document)
    versions/*.html   previous artifacts, newest name sorts last (UTC stamp)
    data/latest.json  newest snapshot written by the space's collector
    data/history.jsonl  one snapshot summary per line, oldest first
    brief.json        the bot's latest narrative: headline, status, items

The desktop half renders ``artifact.html`` in a sandboxed frame and hands it the
data; this module only reads those files, plus a revert route that restores an
older artifact. It never executes anything from a space folder. Hermes applies
authentication before a request reaches this module.

The dashboard imports this file by path (no parent package), so everything lives
in one module.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

PLUGIN_ID = "hermes-spaces"
VERSION = "0.1.0"

router = APIRouter()

MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_HISTORY_LINES = 2000
DEFAULT_HISTORY = 540
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_VERSION_RE = re.compile(r"^[0-9]{8}T[0-9]{6}(?:-[0-9]{1,3})?Z?\.html$")


def spaces_root() -> Path:
    """The global spaces root. Not profile-scoped: a space is shared by its bot
    (its own profile) and every desktop that renders it."""
    raw = os.environ.get("HERMES_SPACES_ROOT")
    return Path(raw).expanduser() if raw else Path.home() / ".hermes" / "spaces"


def _space_dir(space_id: str) -> Path:
    if not _ID_RE.fullmatch(space_id or ""):
        raise HTTPException(status_code=400, detail="invalid space id")
    root = spaces_root().resolve()
    path = (root / space_id)
    if path.is_symlink() or not path.is_dir():
        raise HTTPException(status_code=404, detail="space not found")
    resolved = path.resolve()
    if resolved.parent != root:
        raise HTTPException(status_code=404, detail="space not found")
    return resolved


def _inside(base: Path, rel: str) -> Path:
    target = (base / rel)
    if target.is_symlink():
        raise HTTPException(status_code=400, detail="symlinks are not served")
    resolved = target.resolve()
    if base not in resolved.parents:
        raise HTTPException(status_code=400, detail="path escapes space")
    return resolved


def _read_text(path: Path, cap: int) -> Optional[str]:
    try:
        if not path.is_file() or path.is_symlink():
            return None
        with open(path, "rb") as fh:
            data = fh.read(cap + 1)
        if len(data) > cap:
            raise HTTPException(status_code=413, detail=f"{path.name} exceeds {cap} bytes")
        return data.decode("utf-8", errors="replace")
    except OSError:
        return None


def _read_json(path: Path) -> Any:
    text = _read_text(path, MAX_JSON_BYTES)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return {"_error": f"{path.name} is not valid JSON"}


def _mtime(path: Path) -> Optional[float]:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _history(base: Path, limit: int) -> list:
    path = base / "data" / "history.jsonl"
    text = _read_text(path, MAX_JSON_BYTES * 4)
    if not text:
        return []
    rows = []
    for line in text.splitlines()[-max(1, min(limit, MAX_HISTORY_LINES)):]:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def _meta(base: Path) -> dict:
    meta = _read_json(base / "space.json")
    if not isinstance(meta, dict):
        meta = {}
    meta = {k: v for k, v in meta.items() if not str(k).startswith("_")}
    meta["id"] = base.name
    meta.setdefault("title", base.name.replace("-", " ").title())
    return meta


def _summary(base: Path) -> dict:
    meta = _meta(base)
    brief = _read_json(base / "brief.json")
    brief = brief if isinstance(brief, dict) else {}
    latest = base / "data" / "latest.json"
    latest_json = _read_json(latest)
    status = brief.get("status")
    if not status and isinstance(latest_json, dict):
        status = latest_json.get("status")
    return {
        **meta,
        "headline": brief.get("headline"),
        "status": status,
        "brief_updated_at": brief.get("updated_at"),
        "data_updated_at": _mtime(latest),
        "artifact_updated_at": _mtime(base / "artifact.html"),
        "has_artifact": (base / "artifact.html").is_file(),
    }


@router.get("/health")
async def health():
    root = spaces_root()
    return {"ok": True, "plugin": PLUGIN_ID, "version": VERSION, "root_exists": root.is_dir()}


@router.get("/spaces")
async def list_spaces():
    root = spaces_root()
    out = []
    if root.is_dir():
        for child in sorted(root.iterdir()):
            if child.is_symlink() or not child.is_dir() or not _ID_RE.fullmatch(child.name):
                continue
            if not (child / "space.json").is_file():
                continue
            try:
                out.append(_summary(child.resolve()))
            except HTTPException:
                continue
    out.sort(key=lambda s: (s.get("order", 100), s.get("title", "")))
    return {"spaces": out}


@router.get("/spaces/{space_id}")
async def get_space(space_id: str, history: int = Query(DEFAULT_HISTORY, ge=0, le=MAX_HISTORY_LINES)):
    base = _space_dir(space_id)
    artifact = _read_text(base / "artifact.html", MAX_ARTIFACT_BYTES)
    return {
        "space": _summary(base),
        "artifact": artifact,
        "data": {
            "latest": _read_json(base / "data" / "latest.json"),
            "history": _history(base, history) if history else [],
            "brief": _read_json(base / "brief.json"),
        },
    }


# ---- asking the space's bot -------------------------------------------------
#
# A question asked from a space runs as one turn on the space's bot, in a
# conversation dedicated to that space (asks/thread.json holds its session id),
# so follow-ups keep context and the bot's alert inbox stays clean. Progress is
# streamed into asks/<id>.json, which the page polls.

MAX_QUESTION = 1500
ASK_TIMEOUT_S = 300
_ASK_ID_RE = re.compile(r"^[0-9]{13}-[0-9a-f]{6}$")
_running: dict = {}


def _asks_dir(base: Path) -> Path:
    d = base / "asks"
    if d.is_symlink():
        raise HTTPException(status_code=400, detail="asks folder is a symlink")
    d.mkdir(exist_ok=True)
    return d


def _write_json(path: Path, obj: Any) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


def _digest(base: Path) -> str:
    """Compact context so simple questions need no tool calls."""
    latest = _read_json(base / "data" / "latest.json") or {}
    brief = _read_json(base / "brief.json") or {}
    hist = _history(base, 42)
    lines = []
    if isinstance(brief, dict) and brief.get("headline"):
        lines.append(f"Your last brief ({brief.get('updated_at')}): {brief.get('headline')}")
    if isinstance(latest, dict):
        lines.append(f"Snapshot {latest.get('collected_at')}, status {latest.get('status')}:")
        for c in latest.get("checks", [])[:12]:
            lines.append(f"- {c.get('label')}: {c.get('status')} | {c.get('value')} | {c.get('detail', '')}")
        ops = latest.get("ops") or {}
        if ops.get("dream"):
            d = ops["dream"]
            lines.append(f"- dream: last start {d.get('last_start')}, exit {d.get('last_exit')}, next {d.get('next_run')}")
        w = latest.get("writes") or {}
        if w:
            lines.append(f"- writes by day: {json.dumps(w.get('by_day_14d'))}; by op 7d: {json.dumps(w.get('by_operation_7d'))}")
    if isinstance(latest, dict) and latest.get("nights"):
        lines.append("Nights (date: step results; facts learned):")
        for n in latest["nights"][-8:]:
            if n.get("missing"):
                lines.append(f"- {n['date']}: no run")
                continue
            st = ", ".join(f"{k}={v}" for k, v in (n.get("steps") or {}).items() if v != "na")
            extra = f"; {n.get('facts_learned')} facts" if n.get("facts_learned") is not None else ""
            extra += f" ({n['facts_why']})" if n.get("facts_why") else ""
            extra += f"; killed: {n['killed']}" if n.get("killed") else ""
            lines.append(f"- {n['date']}: {st or 'not tracked'}{extra}")
    if isinstance(latest, dict):
        pipe = latest.get("pipeline") or {}
        ch = pipe.get("changed_since_last_run") or []
        if ch:
            lines.append("Pipeline files changed since last night's run: " + ", ".join(f"{c['label']} ({c['file']}, {c['changed']})" for c in ch))
        if pipe.get("knobs"):
            lines.append("Current limits: " + ", ".join(f"{k['label']} {k['value']:g} {k['unit']}" for k in pipe["knobs"]))
        for k in ("restore", "backlog", "headroom", "downtime"):
            if latest.get(k):
                lines.append(f"{k}: {json.dumps(latest[k])[:400]}")
        pr = latest.get("predictions") or {}
        if pr.get("resolved"):
            lines.append(f"Your prediction record: {pr['right']} of {pr['resolved']} right")
    if hist:
        keys = ("pages", "orphans", "wanted", "unattributed", "writes_24h")
        first, last = hist[0], hist[-1]
        moves = ", ".join(f"{k} {first.get(k)}→{last.get(k)}" for k in keys if first.get(k) != last.get(k))
        lines.append(f"History {first.get('t')} → {last.get('t')} ({len(hist)} snapshots): {moves or 'no change'}")
    return "\n".join(lines)


def _prompt(base: Path, meta: dict, question: str, context: str) -> str:
    return (
        f"[{meta.get('title')} space] {question}\n\n"
        f"(Asked from the space page. Your reply renders in a narrow panel beside the view: "
        f"first line is the direct answer in bold (yes/no first when the question is yes/no), then at most "
        f"3 short bullets of evidence that don't repeat each other or the page, then a final line starting "
        f"'**Do:**' with the one action, or '**Do:** nothing.' Under 90 words. Plain language, no internal "
        f"jargon unless he used it. "
        f"Answer from the digest below when it is enough; investigate read-only only when it isn't. "
        f"Space folder: {base}.)\n"
        + (f"\nClicked element: {context[:500]}\n" if context else "")
        + f"\nDigest:\n{_digest(base)}"
    )


def _step_label(name: str, inp: Any) -> str:
    s = json.dumps(inp) if not isinstance(inp, str) else inp
    if "gbrain_read.py" in s:
        m = re.search(r"gbrain_read\.py\s+([a-z_]+)", s)
        return f"Querying gbrain ({m.group(1).replace('_', ' ')})" if m else "Querying gbrain"
    if "journalctl" in s:
        return "Reading service logs"
    if "systemctl" in s:
        return "Checking services"
    if name == "read_file":
        m = re.search(r"([\w.-]+)['\"]?\s*[,}]", s)
        return f"Reading {m.group(1)}" if m else "Reading a file"
    if name in ("search_files",):
        return "Searching files"
    if name == "terminal":
        return "Running a check"
    if name and name.startswith("mcp_"):
        return "Querying " + name.split("__")[0].replace("mcp_", "")
    return name.replace("_", " ").capitalize() if name else "Working"


def _run_ask(base: Path, meta: dict, ask_path: Path, record: dict, prompt: str) -> None:
    import shutil as _sh
    import subprocess
    import threading

    bot = meta.get("bot")
    thread_file = base / "asks" / "thread.json"
    thread = _read_json(thread_file) or {}
    qfile = ask_path.with_suffix(".prompt.txt")
    qfile.write_text(prompt, encoding="utf-8")
    exe = _sh.which("hermes") or "hermes"
    cmd = [exe, "-p", bot, "chat", "--query-file", str(qfile), "--format", "stream-json", "-s", "space-keeper"]
    if isinstance(thread, dict) and thread.get("session_id"):
        cmd += ["--resume", thread["session_id"]]
    text, last_flush = "", 0.0

    def flush(force=False):
        nonlocal last_flush
        if force or time.time() - last_flush > 0.4:
            record["answer"] = text.strip()
            _write_json(ask_path, record)
            last_flush = time.time()

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                cwd=str(base), env=dict(os.environ, HERMES_SPACE=base.name))
        killer = threading.Timer(ASK_TIMEOUT_S, proc.kill)
        killer.start()
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "text":
                text += ev.get("text", "")
                record["state"] = "answering"
                flush()
            elif t == "tool_use":
                record["steps"].append({"label": _step_label(ev.get("name", ""), ev.get("input")), "at": time.time()})
                record["state"] = "investigating"
                text = ""  # pre-tool narration is not the answer
                flush(True)
            elif t == "result":
                if ev.get("text"):
                    text = ev["text"]
                record["session_id"] = ev.get("session_id")
                record["tokens"] = (ev.get("tokens") or {}).get("total")
                record["duration_ms"] = ev.get("duration_ms")
                if ev.get("error"):
                    record["error"] = str(ev["error"])[:400]
        proc.wait()
        killer.cancel()
        if proc.returncode and not text.strip():
            record["error"] = record.get("error") or ("timed out" if proc.returncode < 0 else f"exit {proc.returncode}")
        record["state"] = "error" if record.get("error") and not text.strip() else "done"
        if record.get("session_id"):
            _write_json(thread_file, {"session_id": record["session_id"], "bot": bot, "updated_at": time.time()})
    except Exception as exc:  # noqa: BLE001 — surface any failure to the page
        record["state"], record["error"] = "error", str(exc)[:400]
    finally:
        record["finished_at"] = time.time()
        flush(True)
        try:
            qfile.unlink()
        except OSError:
            pass
        _running.pop(base.name, None)


class AskBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION)
    context: str = Field("", max_length=600)
    new_thread: bool = False


@router.post("/spaces/{space_id}/ask")
async def ask(space_id: str, body: AskBody):
    import secrets
    import threading

    base = _space_dir(space_id)
    meta = _meta(base)
    if not meta.get("bot") or not _ID_RE.fullmatch(str(meta["bot"])):
        raise HTTPException(status_code=400, detail="space has no valid bot")
    if space_id in _running:
        raise HTTPException(status_code=409, detail="the bot is still answering the previous question")
    adir = _asks_dir(base)
    if body.new_thread and (adir / "thread.json").exists():
        os.replace(adir / "thread.json", adir / f"thread-{int(time.time())}.json")
    ask_id = f"{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    record = {"id": ask_id, "question": body.question.strip(), "context": body.context.strip(),
              "state": "queued", "steps": [], "answer": "", "bot": meta["bot"], "asked_at": time.time()}
    path = adir / f"{ask_id}.json"
    _write_json(path, record)
    _running[space_id] = ask_id
    prompt = _prompt(base, meta, record["question"], record["context"])
    threading.Thread(target=_run_ask, args=(base, meta, path, record, prompt), daemon=True).start()
    return {"ok": True, "ask": record}


@router.get("/spaces/{space_id}/asks")
async def list_asks(space_id: str, limit: int = Query(20, ge=1, le=100)):
    base = _space_dir(space_id)
    adir = base / "asks"
    rows = []
    if adir.is_dir() and not adir.is_symlink():
        names = sorted(f.name for f in adir.iterdir() if f.suffix == ".json" and _ASK_ID_RE.fullmatch(f.stem))
        for n in names[-limit:]:
            r = _read_json(adir / n)
            if isinstance(r, dict):
                rows.append(r)
    thread = _read_json(adir / "thread.json") if adir.is_dir() else None
    return {"asks": rows, "running": _running.get(space_id),
            "thread_session": (thread or {}).get("session_id") if isinstance(thread, dict) else None}


@router.get("/spaces/{space_id}/versions")
async def list_versions(space_id: str):
    base = _space_dir(space_id)
    vdir = base / "versions"
    rows = []
    if vdir.is_dir() and not vdir.is_symlink():
        for f in sorted(vdir.iterdir()):
            if _VERSION_RE.fullmatch(f.name) and f.is_file() and not f.is_symlink():
                rows.append({"name": f.name, "bytes": f.stat().st_size, "mtime": f.stat().st_mtime})
    return {"versions": rows[::-1]}


class RevertBody(BaseModel):
    version: str = Field(..., max_length=64)


@router.post("/spaces/{space_id}/revert")
async def revert(space_id: str, body: RevertBody):
    """Restore an older artifact. The current one is versioned first, so a
    revert is itself undoable."""
    base = _space_dir(space_id)
    if not _VERSION_RE.fullmatch(body.version):
        raise HTTPException(status_code=400, detail="invalid version name")
    vdir = _inside(base, "versions")
    source = _inside(vdir, body.version)
    if not source.is_file():
        raise HTTPException(status_code=404, detail="version not found")
    text = _read_text(source, MAX_ARTIFACT_BYTES)
    if text is None:
        raise HTTPException(status_code=404, detail="version unreadable")
    current = base / "artifact.html"
    if current.is_file() and not current.is_symlink():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest = vdir / f"{stamp}.html"
        n = 1
        while dest.exists():
            dest = vdir / f"{stamp[:-1]}-{n}Z.html"
            n += 1
        shutil.copy2(current, dest)
    fd, tmp = tempfile.mkstemp(dir=base, prefix=".artifact-", suffix=".html")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, current)
    return {"ok": True, "restored": body.version, "at": time.time()}
