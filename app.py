"""Compatibility shim for tests and tools that `import app`.

Launch the local API with:
  py -m uvicorn server:app --host 0.0.0.0 --port 8000

Do not deploy this file to static hosting; it is for local/backend dev only.
"""
import sys

import server as _server

sys.modules[__name__] = _server
