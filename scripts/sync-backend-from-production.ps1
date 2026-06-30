# Backend paths synced from production for local dev (not deployed to static hosts).
#
# DEPRECATED: Prefer a dedicated backend worktree instead of copying onto main:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-backend-worktree.ps1
# See docs/REPO_STRATEGY.md

$backendPaths = @(
  "server.py",
  "app.py",
  "requirements.txt",
  "ASR.py",
  "audio_cleaning.py",
  "bmo_tts.py",
  "CHAT.py",
  "CHAT2.py",
  "CHAT3.py",
  "CHAT_REASONING.py",
  "CHAT_REASONING_DEEP.py",
  "TTS.py",
  "LLM.py",
  "QWEN.py",
  "intent.py",
  "math_code_executor.py",
  "safety_limits.py",
  ".env.example",
  "Server Instruction.txt",
  "actions",
  "auth",
  "cost_logging",
  "supabase",
  "static",
  "docker",
  "tests",
  "scripts",
  "sandbox",
  "vera-api",
  "run_reasoning_gate_tests.py",
  "run_vera_infer_tests.py",
  "run_vera_infer_tests_v2.py",
  "package.json",
  "package-lock.json"
)

Write-Host "Checking out backend/dev files from production onto current branch..."
git checkout production -- @backendPaths
Write-Host "Done. Frontend landing (index.html, styles.css, product.css) was NOT changed."
