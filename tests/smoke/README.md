# tests/smoke/

Dev-only smoke tests, moved here on 2026-05-27 as part of the cleanup pass.

These scripts are NOT loaded by the runtime app (`app.py` / `app.js` /
`index.html`). They exist purely to give a fast assertion harness for
specific feature areas after we touch them.

## Conventions

- Filenames are prefixed with `__` to make it obvious they are dev-only
  and to sort them at the top of file listings.
- One smoke file per spec area (ASR mode, news routing, reasoning close,
  multi-device concurrency, music volume dedupe, etc.).
- Python smoke files stub heavy modules (`TTS`, `ASR`, etc.) before
  `import app` so they don't need the full server stack.
- `.mjs` smoke files carve a region out of `app.js` and run it in a
  Node `vm` sandbox with a fake `window` / `localStorage`.

## Running

All commands are run from the repo root.

```pwsh
# Python
py -3 tests/smoke/__news_intent_router_smoke.py
py -3 tests/smoke/__asr_mode_smoke.py
py -3 tests/smoke/__reasoning_close_smoke.py
# ...

# Node
node tests/smoke/__asr_mode_smoke.mjs
node tests/smoke/__reasoning_close_polish_smoke.mjs
# ...
```

Python files contain a small `sys.path` bootstrap at the top so they
resolve `import app` after the move. `.mjs` files either use
`process.cwd()` (run from repo root) or `__dirname` + `..` (location
independent).

## Adding new smoke tests

Place new files here, name them `__<area>_smoke.{py,mjs}`, and write a
one-line `Run:` example in the docstring. Do NOT import these from
production code.
