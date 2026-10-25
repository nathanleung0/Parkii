"""Check local agent readiness without network requests or printing configuration values."""
import os
import sys
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Mapping
from urllib.parse import urlsplit

from .config import load_env


@dataclass(frozen=True)
class Check:
    status: str
    name: str
    message: str


def cloud_site_configured(value: str) -> bool:
    """Accept only a Convex cloud HTTP-actions origin; never send credentials here."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        deployment = host.removesuffix(".convex.site")
        return (
            value == value.strip()
            and not any(c.isspace() or ord(c) < 32 for c in value)
            and parsed.scheme == "https"
            and host.endswith(".convex.site")
            and bool(deployment)
            and all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in deployment)
            and deployment[0].isalnum()
            and deployment[-1].isalnum()
            and parsed.username is None
            and parsed.password is None
            and parsed.port is None
            and parsed.netloc.lower() == host
            and parsed.path in ("", "/")
            and not parsed.query
            and not parsed.fragment
        )
    except ValueError:
        return False


def check_settings(env: Mapping[str, str]) -> list[Check]:
    checks = []
    site = env.get("CONVEX_SITE_URL") or env.get("VITE_CONVEX_SITE_URL", "")
    cloud_ready = cloud_site_configured(site)
    checks.append(Check(
        "PASS" if cloud_ready else "FAIL",
        "Convex cloud URL",
        "Cloud URL configured (value hidden)." if cloud_ready else
        "Ask Andrew for the HTTPS deployment URL ending in .convex.site; set CONVEX_SITE_URL.",
    ))
    for name, missing in (
        ("AGENT_SECRET", "Ask Andrew for the matching backend secret through a private channel."),
        ("AGENT_SEED", "Agree who hosts the demo agent, then store its stable private seed locally."),
    ):
        configured = bool(env.get(name, "").strip())
        checks.append(Check("PASS" if configured else "FAIL", name,
                            "Configured (value hidden)." if configured else missing))
    remote_rules = bool(env.get("RULES_AGENT_ADDRESS", "").strip())
    checks.append(Check(
        "PASS" if remote_rules else "WARN", "Rules Agent",
        "Remote agent address configured; delivery is not verified." if remote_rules else
        "Using in-process rules fallback; this is not evidence of agent-to-agent delivery.",
    ))
    return checks


def main() -> int:
    load_env()
    checks = [Check("PASS" if sys.version_info >= (3, 10) else "FAIL", "Python",
                    "Python 3.10 or newer is required; the team uses Python 3.13.")]
    for package in ("uagents", "tzdata"):
        try:
            installed = version(package)
            ok = package != "uagents" or installed == "0.26.1"
            checks.append(Check("PASS" if ok else "FAIL", package,
                                "Required package installed." if ok else
                                "Install the pinned version from agents/requirements.txt."))
        except PackageNotFoundError:
            checks.append(Check("FAIL", package, "Install agents/requirements.txt in agents/.venv."))
    checks.extend(check_settings(os.environ))
    for check in checks:
        print(f"[{check.status}] {check.name}: {check.message}")
    print("Offline checks only: no API calls, no agent registration, and no configuration values printed.")
    print("A pass does not verify backend access, mailbox registration, ASI:One chat, or sponsor eligibility.")
    return 1 if any(check.status == "FAIL" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
