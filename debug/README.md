# debug/

Dev-only helpers and prototypes that are **NOT** part of the runtime app.

Nothing in this folder is imported by `app.py`, `app.js`, or `index.html`.
Files here exist for manual experimentation, ad-hoc reproduction of
issues, or pre-feature prototypes that were never wired in.

## Contents

| Path                                   | Purpose                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convo_tester.py`                      | Stand-alone CLI REPL that talks to the local `LLM.py` model (HuggingFace Llama path). Predates the FastAPI server. Useful for debugging a raw model without HTTP. |
| `static-search-prototype/searching.js` | First sketch of the "open side panel with search results" UX. Uses a mock `mockSearch()` (no real backend). Never imported by `index.html` or `app.js`.            |
| `static-search-prototype/test-search.html` | Stand-alone page that loaded the prototype `searching.js`. Run with any static server in this folder; not served by the FastAPI app any more.                 |

## Why these were moved

Before cleanup, `convo_tester.py` lived at the repo root next to the
real `app.py`; the search prototype lived under `static/` and was therefore
publicly served by `app.mount("/static", ...)`. Moving them out of those
paths makes the runtime surface area smaller and prevents accidental
exposure of test pages on a live deployment.

## Reviving these later

Nothing here is wired up. To re-use:
- `convo_tester.py` — make sure `LLM.py` still exists at the repo root
  and your model paths are valid, then `py -3 debug/convo_tester.py`.
- `static-search-prototype/` — re-copy into `static/` if you want it
  served, or open `test-search.html` directly from disk.
