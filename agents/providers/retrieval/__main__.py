"""Smoke-test CLI against a real Elastic Serverless project (needs ELASTIC_* env vars).

  python -m agents.providers.retrieval setup
  python -m agents.providers.retrieval seed            # indexes labeled DEMO FIXTURES for user demo-user
  python -m agents.providers.retrieval search "battery recycling costs" [--agent] [--workspace ID]

Seeded rows are fixtures, not evidence of real sources. --agent is blocked until server-side
authorization is implemented; direct tool execution is not complete agent-track evidence.
"""
import json
import sys

from .elastic import ElasticRetrieval, SearchScope

DEMO_USER, DEMO_WS = "demo-user", "demo-workspace"
FIXTURES = [
    ("fx-1", "[demo fixture] How lithium-ion batteries are recycled",
     "Hydrometallurgical recycling dissolves shredded cells to recover lithium, cobalt and nickel. "
     "Direct recycling keeps cathode material intact and can cut energy use, but needs sorted input."),
    ("fx-2", "[demo fixture] Cost comparison of battery recovery methods",
     "Pyrometallurgy has high capital cost and energy use. Hydrometallurgy has lower energy cost but "
     "needs reagents. Plant economics depend on cobalt prices and the volume of end-of-life packs."),
]


def main(argv):
    if not argv:
        sys.exit(__doc__)
    svc = ElasticRetrieval()
    cmd = argv[0]
    if cmd == "setup":
        print(json.dumps(svc.ensure_setup(), indent=2))
    elif cmd == "seed":
        for sid, title, text in FIXTURES:
            src = {"id": sid, "url": f"https://example.com/{sid}", "title": title, "text": text,
                   "availability": "ready", "retrievedAt": "2026-10-24T12:00:00Z"}
            print(sid, svc.index_source(src, user_id=DEMO_USER, workspace_id=DEMO_WS, consent=True))
    elif cmd == "search" and len(argv) >= 2:
        ws = argv[argv.index("--workspace") + 1] if "--workspace" in argv else None
        user = argv[argv.index("--user") + 1] if "--user" in argv else DEMO_USER
        res = svc.search_sources(argv[1], SearchScope(user, ws), via_agent="--agent" in argv)
        print(json.dumps({"hits": res.hits, "trace": res.trace}, indent=2))
    else:
        sys.exit(__doc__)


main(sys.argv[1:])
