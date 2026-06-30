# VERA repo strategy

## Recommendation: **Option B** (separate backend source of truth)

Use a **dedicated backend checkout** (git worktree now → separate GitHub repo later).
Keep **two frontend branches** in `VERA-ai` for different landing/UI only.

| Option | Verdict |
|--------|---------|
| **A** — backend only on `production`, copy to `main` sometimes | Short-term OK; you already hit the pain of branch switching and manual sync. |
| **B** — backend in its own repo or worktree | **Best fit.** One place for `server.py`, `actions/`, `auth/`, tests. No copying between `main` and `production`. |
| **C** — monorepo `frontend-demo/`, `frontend-product/`, `backend/` | Breaks GitHub Pages root layout unless you reconfigure Pages build paths. More refactor than B for little gain. |

### Phases

1. **Now:** `production` branch = canonical backend tree. `main` = demo frontend (+ optional slim backend copy removed over time). Local API via **git worktree** (`scripts/setup-backend-worktree.ps1`).
2. **Later:** New repo `VERA-backend` — push canonical backend once, delete Python tree from `VERA-ai`, submodule or second clone for local dev.

---

## What deploys where

| Target | Branch | What gets published | What runs |
|--------|--------|---------------------|-----------|
| **GitHub Pages** | `main` | Static frontend only (`deploy-vera.ps1 -Target github`) | HTML/CSS/JS — **not** Python |
| **workwithvera.com** | `production` | Static frontend only (`deploy-vera.ps1 -Target production`) | HTML/CSS/JS — **not** Python |
| **api.workwithvera.com** | `vera-api/` on any branch | `npx wrangler deploy` from `vera-api/` | Cloudflare Worker proxy |
| **GPU / RunPod / local** | `production` or backend worktree | Docker / `uvicorn` | `server.py` Python API |

Do **not** connect `workwithvera.com` to GitHub Pages. Do **not** deploy `server.py` via Pages.

---

## File taxonomy

### Branch-specific frontend (UI / landing)

| File / area | `main` (demo) | `production` (product) |
|-------------|---------------|----------------------|
| `index.html` | GitHub demo landing | workwithvera.com landing |
| `styles.css` | Demo styles (legacy full sheet) | Shared base (slim) |
| `product.css` | — | Product landing only |
| `landing.css`, `landing.js` | Legacy demo (remove when unused) | — |
| Root media (`background.mp4`, `me.jpg`, …) | Can differ per brand | Can differ per brand |

### Shared frontend (merge or cherry-pick between branches)

Same behavior on both sites; both call `https://api.workwithvera.com`:

- `app/index.html`, `app/app.js`, `app/shell.js`
- `config/`
- `utils/`, `users/`, `voice/`, `workmode/`, `news/`, `debug/`

### Backend / system (single source of truth — **do not fork per branch**)

Edit only in **backend worktree** or future `VERA-backend` repo:

- `server.py`, `app.py` (import shim)
- `requirements.txt`, `.env.example`
- `actions/`, `auth/`, `cost_logging/`, `supabase/`
- `CHAT*.py`, `TTS.py`, `ASR.py`, `LLM.py`, `QWEN.py`, `intent.py`, `bmo_tts.py`, `audio_cleaning.py`, `math_code_executor.py`, `safety_limits.py`
- `static/` (API fillers), `docker/`
- `tests/` (Python smokes), `run_*.py`
- `Server Instruction.txt`

### Edge / proxy (shared, deploy separately)

- `vera-api/` — Cloudflare Worker (not the Python server)

### Tooling (repo meta, not deployed to Pages)

- `deploy-vera.ps1`, `scripts/`

---

## Day-to-day workflow

### Product landing UI (`production`)

```powershell
git checkout production
# edit index.html, product.css, styles.css
git commit -am "Production: landing UI"
git push origin production
# Cloudflare Pages auto-deploys
```

### Demo landing UI (`main`)

```powershell
git checkout main
# edit index.html, styles.css only
git commit -am "Demo: landing UI"
git push origin main
```

### Shared app fix (both sites)

```powershell
git checkout main
# edit app/app.js, voice/, users/, etc.
git commit -am "Fix: voice routing"
git push origin main

git checkout production
git cherry-pick <sha>
# resolve index.html / styles.css / product.css conflicts with --ours if needed
git push origin production
```

### Backend / system (never on `main` vs `production` copy-paste)

```powershell
# One-time:
powershell -ExecutionPolicy Bypass -File .\scripts\setup-backend-worktree.ps1

# Every backend change:
cd ..\Online_demo-backend
# edit server.py, actions/, auth/, tests/, ...
git add .
git commit -m "Backend: describe change"
git push origin production

# Deploy Python server to your GPU/RunPod host from this tree (not via Pages).
# Deploy Worker if CORS/routes changed:
cd vera-api
npx wrangler deploy
```

### Local full stack

```powershell
# Terminal 1 — backend worktree
cd ..\Online_demo-backend
py -m uvicorn server:app --host 0.0.0.0 --port 8000

# Terminal 2 — frontend (main or production)
cd C:\Users\User\Documents\VERA\Online_demo
git checkout main   # or production
npx serve .
# open /app/
```

---

## Local launch command

```powershell
py -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Run from **backend worktree** or `production` checkout — not required on `main`.

---

## Deprecated

- `scripts/sync-backend-from-production.ps1` — one-way file copy; use **worktree** instead so `main` stays frontend-focused.
