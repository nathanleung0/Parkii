"""Tiny .env loader (no python-dotenv dependency). Real environment variables win over the file."""
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def load_env() -> None:
    for path in (ROOT / ".env", ROOT.parent / ".env.local"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"Missing {name}. Copy agents/.env.example to agents/.env and fill it in.")
    return value
