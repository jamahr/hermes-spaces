"""Serve the CURRENT plugin_api.py on a side port, under the same /api/plugins/hermes-spaces prefix.

Used by live tests to exercise backend changes in the real UI without restarting the gateway
(Hermes mounts plugin routes once, at gateway start). Loopback only. Usage:
    <hermes python> -I tests/side_backend.py 9131
"""
import importlib.util
import sys

sys.path.insert(0, "/root/.hermes/hermes-agent")
import hermes_bootstrap  # noqa: E402,F401  (puts Hermes deps on the path)
import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402

spec = importlib.util.spec_from_file_location("spaces_api", "/root/.hermes/plugins/hermes-spaces/dashboard/plugin_api.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
app = FastAPI()
app.include_router(mod.router, prefix="/api/plugins/hermes-spaces")
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
