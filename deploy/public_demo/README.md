# Public Demo Deployment

This directory contains the lightweight server deployment path for a semi-private public demo. It is intentionally separate from the local Windows/Docker demo path.

## Boundaries

- Do not expose the Dify console.
- Do not expose the runtime configuration center.
- Do not commit real API keys, SSH passwords, Dify database backups, or private book storage.
- Bind Flask to `127.0.0.1:18000`.
- Expose only the frontend/static proxy on `0.0.0.0:15173`.
- Keep existing server projects and ports untouched.

## Demo Limits

The public demo mode is controlled by backend environment variables:

```text
PUBLIC_DEMO_MODE=1
PUBLIC_DEMO_TEMPLATE_BOOK_ID=7558519503458405438
PUBLIC_DEMO_SESSION_TTL_SECONDS=600
PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT=25
PUBLIC_DEMO_WORLD_INIT_LIMIT=1
```

This means every visitor gets a temporary cookie-based sandbox. The bookshelf can still import books, but the backend stores only the first 25 chapters. World initialization can run once per temporary session/book. Rolling three-chapter continuation can be run repeatedly.

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

Smoke checks:

```bash
curl http://127.0.0.1:18000/health
curl http://127.0.0.1:15173/api/demo/session
curl http://127.0.0.1:15173/bookshelf.html
```
