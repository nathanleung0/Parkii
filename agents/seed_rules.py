"""One-time: crawl public SFMTA parking-rule pages with Apify and index them in Elastic.

Run:  python -m agents.seed_rules
Needs APIFY_TOKEN and ELASTIC_KIBANA_URL / ELASTIC_ES_URL / ELASTIC_API_KEY (and ELASTIC_INDEX=parksight-rules).
Prints the real Apify run ids and index receipts: that output is the evidence for those sponsors.
"""
import sys

from .config import load_env
from .providers.extract import ApifyExtractor
from .providers.provider_common import ProviderError
from .providers.retrieval import ElasticRetrieval
from .rules_service import DEMO_USER, WORKSPACE

PAGES = [
    "https://www.sfmta.com/getting-around/drive-park/how-avoid-parking-tickets",
    "https://www.sfmta.com/getting-around/drive-park/parking-meters",
    "https://www.sfmta.com/getting-around/drive-park/parking-meters/pay-or-permit-parking",
    "https://www.sfmta.com/getting-around/drive-park/color-curb",
]


def main() -> int:
    load_env()
    try:
        extractor, elastic = ApifyExtractor(), ElasticRetrieval()
        print("Elastic setup:", elastic.ensure_setup())
    except ProviderError as e:
        print(f"Not configured: {e.code} {e}")
        return 1

    failures = 0
    for i, url in enumerate(PAGES, 1):
        result = extractor.extract_article(url, source_id=f"sfmta-{i}")
        print(f"[{i}] {url}\n    apify run: {result.trace.get('apifyRunId')} status: {result.trace.get('finalStatus')}")
        if result.source["availability"] != "ready":
            print("    extraction failed:", result.error)
            failures += 1
            continue
        receipt = elastic.index_source(result.source, user_id=DEMO_USER, workspace_id=WORKSPACE, consent=True)
        print(f"    indexed {receipt.doc_id}: {receipt.status}", receipt.error or "")
        failures += receipt.status != "ready"
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
