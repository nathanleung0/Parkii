"""Public-URL validation for article extraction (contracts/ANDREW.md, cloud consent section).

Only explicit public http(s) article URLs may reach Apify. Credentials are stripped;
private, loopback, link-local, reserved and other non-global destinations are rejected,
including names that resolve to them. Call again on the final loaded URL to validate redirects.
"""
import ipaddress
import socket
from urllib.parse import urlsplit, urlunsplit

from ..provider_common import ProviderError

MAX_URL_LENGTH = 2048
ALLOWED_PORTS = {None, 80, 443}
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".corp")


def _is_public(ip_text: str) -> bool:
    ip = ipaddress.ip_address(ip_text.split("%")[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def validate_public_url(url: str, resolver=socket.getaddrinfo) -> str:
    """Return the URL with credentials stripped, or raise VALIDATION_ERROR / CONTENT_UNAVAILABLE."""
    if not isinstance(url, str) or not url.strip():
        raise ProviderError("VALIDATION_ERROR", "url is required")
    url = url.strip()
    if len(url) > MAX_URL_LENGTH:
        raise ProviderError("VALIDATION_ERROR", "url is too long")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise ProviderError("VALIDATION_ERROR", "url is malformed")
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise ProviderError("VALIDATION_ERROR", "only http and https urls are allowed")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise ProviderError("VALIDATION_ERROR", "url has no host")
    if port not in ALLOWED_PORTS:
        raise ProviderError("VALIDATION_ERROR", "only the default web ports are allowed")
    single_label = "." not in host and ":" not in host
    if host == "localhost" or host.endswith(_BLOCKED_SUFFIXES) or single_label:
        raise ProviderError("VALIDATION_ERROR", "private or local destinations are not allowed")

    try:
        infos = resolver(host, port or (443 if scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ProviderError("CONTENT_UNAVAILABLE", "host could not be resolved")
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(_is_public(a) for a in addresses):
        raise ProviderError("VALIDATION_ERROR", "private or local destinations are not allowed")

    netloc = host if ":" not in host else f"[{host}]"
    if port:
        netloc += f":{port}"
    return urlunsplit((scheme, netloc, parts.path, parts.query, ""))
