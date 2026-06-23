# Supabase local setup

1. Copy `.env.example` to `.env` in the project root.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_JWT_SECRET` from the Supabase Dashboard → Project Settings → API.
3. Apply migrations in `supabase/migrations/` (001 through 005) via the SQL editor or CLI.
4. Restart the FastAPI server after editing `.env`.

**Never commit `.env` or paste service-role keys into the repo.**

PowerShell example (replace with your values):

```powershell
cd path\to\Online_demo
$env:SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "your-service-role-key"
$env:SUPABASE_JWT_SECRET = "your-jwt-secret"
py -3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```
