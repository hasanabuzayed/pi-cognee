## Troubleshooting

Run `/cognee-doctor`. It prints the resolved mode and why, the env file state, shell overrides,
API key source, server reachability + latency + version, readable datasets, session id, breaker
state, and all timeouts. Common cases:

- **"offline (cannot reach cognee server …)"** — the server is not running at the expected URL.
  In local mode the [bootstrap](#local-server-bootstrap) starts one automatically within the
  session (first run takes a few minutes: uv venv + install — the status shows
  `◐ cognee: starting`); with `COGNEE_LOCAL_BOOTSTRAP=off`, start it yourself
  (`uvicorn cognee.api.client:app --port 8011`). Either way the extension reconnects on its own
  within ~60s.
- **"uv not found and automatic install failed"** (bootstrap) — install uv
  ([docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/)) and restart pi;
  `/cognee-doctor`'s *Local runtime* row shows what was found. The bootstrap never touches a
  server that is present (`ready`/`busy`/`unknown` → adopt or refuse with a log line in
  `~/.cognee-plugin/pi/bootstrap.log`).
- **"server present but not serving (verdict=busy…)"** — something holds the port without
  answering `/health` (a busy server still holds the graph store's file lock); pi refuses to
  install or boot over it. Free the port or point `COGNEE_LOCAL_API_URL` elsewhere.
- **auth failed (401/403)** — `COGNEE_API_KEY` missing or wrong for cloud mode. In local mode it
  means the owner-key auto-mint failed or was never attempted: start the server with
  `DEFAULT_USER_PASSWORD` matching `COGNEE_USER_PASSWORD` (defaults:
  `default_user@example.com` / `default_password`) and restart pi, or set `COGNEE_API_KEY`.
- **"COGNEE_BASE_URL missing"** — `COGNEE_BACKEND=cloud` is pinned but no URL is configured.
- **`LLM_API_KEY` missing** — only matters for a *local* server (it needs an LLM); the extension
  itself never calls an LLM.
- **"server rejected content_type='code'"** (indexing) — the server predates cognee 1.5.4;
  upgrade it and re-run `/cognee-index`.
- **Code queries return empty on a cloud server** — the graph reflects the last *pushed* commit;
  push, then re-run `/cognee-index <git-url>` (see [Code graph](#code-graph)).
