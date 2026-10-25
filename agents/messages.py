"""uAgent-to-uAgent messages between the Parkii Agent and the Rules Agent."""
from typing import List, Optional

from uagents import Model


class RulesRequest(Model):
    lat: float
    lng: float
    query: str = ""


class RuleHit(Model):
    title: Optional[str] = None
    url: Optional[str] = None
    excerpt: Optional[str] = None


class RulesResponse(Model):
    cleaning_text: Optional[str] = None
    cleaning_warning: Optional[str] = None  # "now" | "soon" | "later" | None
    hits: List[RuleHit] = []
    datasf: str = "ok"
    elastic: str = "not_configured"
