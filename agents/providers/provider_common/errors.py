"""Typed errors using the shared wire error vocabulary (contracts/JOSH.md#identity-state-and-recovery)."""

ERROR_CODES = frozenset({
    "VALIDATION_ERROR", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "STALE_STATE",
    "PROTECTED", "NEEDS_CLARIFICATION", "APPROVAL_REQUIRED", "EXPIRED",
    "DEVICE_OFFLINE", "FOCUS_DENIED", "STORAGE_FAILED", "PROVIDER_TIMEOUT",
    "CONTENT_UNAVAILABLE", "IDEMPOTENCY_CONFLICT", "INTERNAL_ERROR",
})


class ProviderError(Exception):
    """Raised for failures callers must handle. Messages never contain credentials."""

    def __init__(self, code: str, message: str):
        if code not in ERROR_CODES:
            raise ValueError(f"unknown error code {code!r}")
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}
