# Controlled Resume Demo Deployment

This directory contains the lightweight server deployment path for a controlled resume/interview demo. It is intentionally separate from the local Windows/Docker demo path and is not meant to describe a fully open public service.

## Boundaries

- Do not expose the Dify console.
- Do not expose the runtime configuration center.
- Do not commit real API keys, SSH passwords, Dify database backups, or private book storage.
- Bind Flask to `127.0.0.1:18000`.
- Expose only the selected frontend/static proxy port for the demo entrypoint.
- Keep existing server projects and ports untouched.

## Demo Limits

The controlled demo mode is configured by backend environment variables:

```text
PUBLIC_DEMO_MODE=1
PUBLIC_DEMO_TEMPLATE_BOOK_ID=7558519503458405438
PUBLIC_DEMO_SESSION_TTL_SECONDS=600
PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT=25
PUBLIC_DEMO_WORLD_INIT_LIMIT=1
```

This means every evaluator gets a temporary cookie-based sandbox. The bookshelf can still import books, but the backend stores only the first 25 chapters. World initialization can run once per temporary session/book. Rolling three-chapter continuation can be run repeatedly.

The chapter limit is a storage/cost guard, not a search guard. Evaluators may choose a book with hundreds or thousands of chapters; the import pipeline should still accept the book and only materialize the first `PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT` chapters in the temporary sandbox.

## Server Shape

The verified controlled-demo shape is:

```text
resume/interview entrypoint
  -> frontend/static proxy on the selected demo port
  -> Flask backend on 127.0.0.1:18000
  -> optional private Dify Runtime / model provider
```

Keep the backend loopback-only. The frontend proxy serves `frontend/dist` and forwards API routes to the loopback backend. This avoids exposing the runtime configuration center, raw Flask APIs, model keys, or Dify console, and it reduces the chance of disturbing other demo projects on the same server.

Small machines can host the Novel Agent frontend/backend entrypoint. A 2-core/2GB server is acceptable for a semi-private resume demo, but do not expect it to comfortably run the full Dify stack, PostgreSQL, plugin services, model proxying, and multiple unrelated projects at the same time. If the server is tight, keep Dify in an existing private runtime and connect through App API keys.

## Manual Server Install

These commands assume the repo is checked out at `/opt/novel-agent-demo/app`.

```bash
cd /opt/novel-agent-demo/app
python3 -m venv novel_git_server/.venv_public_demo
novel_git_server/.venv_public_demo/bin/pip install --upgrade pip
novel_git_server/.venv_public_demo/bin/pip install -r novel_git_server/requirements.txt

cd frontend
npm ci
npm run build

mkdir -p /opt/novel-agent-demo/storage
cp deploy/public_demo/.env.example /etc/novel-agent-demo.env
# Edit /etc/novel-agent-demo.env on the server. Put real keys only there.

cp deploy/public_demo/novel-agent-demo-backend.service /etc/systemd/system/
cp deploy/public_demo/novel-agent-demo-frontend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now novel-agent-demo-backend.service novel-agent-demo-frontend.service
```

Important operational notes:

- `npm` must exist on the server before `npm ci && npm run build`. If Node.js/npm is missing, backend hotfixes can still work, but frontend source edits will not reach `frontend/dist`.
- Keep real keys only in `/etc/novel-agent-demo.env`. Do not copy that file into the repository, release zip, or frontend bundle.
- If Dify runs in Docker on the same host, test the address from inside Dify's network. `localhost` often points to the container itself; `host.docker.internal` or the host LAN address may be needed.
- Each imported demo book is still a Git repository. The service environment must be able to commit, so make sure per-repo or global Git `user.name` and `user.email` are available before metadata/chapter commits.
- If you are deploying on a server that already hosts other demos, inventory ports first and only route the chosen demo entrypoint.

Smoke checks:

```bash
curl http://127.0.0.1:18000/health
curl http://127.0.0.1:15173/api/demo/session
curl http://127.0.0.1:15173/bookshelf.html
```

Deployment doctor:

```bash
python deploy/demo/deploy_doctor.py \
  --profile public-demo \
  --env /etc/novel-agent-demo.env \
  --backend-url http://127.0.0.1:18000 \
  --frontend-url http://127.0.0.1:15173
```

The public-demo profile is stricter than the local profile. It checks the cookie sandbox, readonly runtime configuration, the frontend API proxy, and the no-cookie Dify ToolProvider callback path. Local development does not need these session-isolation checks; this server profile does.

If Dify is reachable from this server, include it in the same pass:

```bash
python deploy/demo/deploy_doctor.py \
  --profile public-demo \
  --env /etc/novel-agent-demo.env \
  --frontend-url http://127.0.0.1:15173 \
  --dify-url http://127.0.0.1/v1
```

Service checks:

```bash
systemctl status novel-agent-demo-backend.service --no-pager
systemctl status novel-agent-demo-frontend.service --no-pager
journalctl -u novel-agent-demo-backend.service -n 120 --no-pager
journalctl -u novel-agent-demo-frontend.service -n 120 --no-pager
```

Common symptoms:

| Symptom | Check |
| --- | --- |
| Bookshelf loads but API calls fail | Confirm `novel-agent-demo-frontend.service` proxies API routes to `127.0.0.1:18000` and the backend service is active. |
| Online import fails with Git author identity | Configure Git `user.name` and `user.email` in the book repository or service environment. |
| Frontend source changed but page is unchanged | Rebuild `frontend/dist` with Node.js/npm, then restart the frontend proxy. |
| Dify replies but cannot write files | Check LoreGit ToolProvider endpoint from Dify's runtime network. |
| Server becomes slow | Reduce controlled-demo limits, keep TTL short, and avoid co-locating full Dify on a very small machine. |
| Public-demo session works in browser but Dify callback writes nowhere | Dify callbacks do not carry the browser cookie. The backend must accept a valid live `demo_<session>_<book>` id and bind it back to that session. Run the public-demo doctor profile to verify this. |
| A long imported book stores too much content | `PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT` limits materialized chapters. The import UI may select a long book, but the backend should only store the first configured number of chapters. |
