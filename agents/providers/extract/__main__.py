"""Smoke test with a real Apify run: python -m agents.providers.extract <public article url>
Prints the run ID and a text preview. Needs APIFY_TOKEN in the environment."""
import json
import sys

from . import extract_article

if len(sys.argv) != 2:
    sys.exit("usage: python -m agents.providers.extract <url>")
r = extract_article(sys.argv[1])
out = {"source": {**r.source, "text": (r.source.get("text") or "")[:300]}, "error": r.error, "trace": r.trace}
print(json.dumps(out, indent=2))
