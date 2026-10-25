"""Parking rules for a location: street cleaning (DataSF) + semantic search over crawled SFMTA pages (Elastic).

Elastic only runs when ELASTIC_* is configured. The result says which parts actually ran (`sources`),
so a street-cleaning-only answer is never presented as Elastic evidence.
"""
import os

from . import street_rules
from .providers.provider_common import ProviderError
from .providers.retrieval import ElasticRetrieval, SearchScope

DEMO_USER = "parkii-demo"
WORKSPACE = "castro"
RULES_QUERY = "parking time limits meters permits street cleaning rules"


def elastic_configured() -> bool:
    return all(os.environ.get(k) for k in ("ELASTIC_KIBANA_URL", "ELASTIC_ES_URL", "ELASTIC_API_KEY"))


def lookup_rules(lat: float, lng: float, query: str = "", retrieval=None, cleaning=None) -> dict:
    """Never raises. `retrieval` and `cleaning` are injectable for tests."""
    out = {"streetCleaning": (cleaning or street_rules.lookup)(lat, lng), "hits": [],
           "sources": {"datasf": "ok", "elastic": "not_configured"}}
    if out["streetCleaning"].get("error"):
        out["sources"]["datasf"] = "error:" + out["streetCleaning"]["error"]

    if retrieval is None and not elastic_configured():
        return out
    try:
        service = retrieval or ElasticRetrieval()
        result = service.search_sources(
            f"{RULES_QUERY} {query}".strip()[:500], SearchScope(user_id=DEMO_USER, workspace_id=WORKSPACE))
        out["hits"] = [{k: h.get(k) for k in ("title", "url", "excerpt", "score")} for h in result.hits[:3]]
        out["sources"]["elastic"] = "ok"
    except ProviderError as e:
        out["sources"]["elastic"] = f"error:{e.code}"
    except Exception as e:
        out["sources"]["elastic"] = f"error:{type(e).__name__}"
    return out
