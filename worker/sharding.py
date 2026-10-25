"""Stable camera ownership across independent worker processes."""
import hashlib


def belongs_to_shard(cam_id: str, index: int, count: int) -> bool:
    digest = hashlib.sha256(cam_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % count == index
