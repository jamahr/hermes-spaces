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
