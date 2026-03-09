"""PolyVault service layer — serialize, deserialize, and FAISS rebuild."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import math
import time
import uuid
from typing import Any

MAX_CHUNK_SIZE = 1_000_000


class ChunkIntegrityError(Exception):
    def __init__(self, chunk_index: int, expected: str, actual: str):
        self.chunk_index = chunk_index
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"Chunk {chunk_index} hash mismatch: expected {expected}, got {actual}"
        )


class ChunkReassemblyError(Exception):
    pass


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_str(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _sort_keys_recursive(obj: Any) -> Any:
    """Return a copy of *obj* with all dict keys recursively sorted."""
    if isinstance(obj, dict):
        return {k: _sort_keys_recursive(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_sort_keys_recursive(item) for item in obj]
    return obj


def _deterministic_json(obj: Any) -> str:
    return json.dumps(_sort_keys_recursive(obj), separators=(",", ":"), ensure_ascii=False)


def _compress(data: bytes, mode: str) -> bytes:
    if mode == "none":
        return data
    return gzip.compress(data, compresslevel=6)


def _decompress(data: bytes, mode: str) -> bytes:
    if mode == "none":
        return data
    return gzip.decompress(data)


def _chunk_payload(data: bytes, max_chunk_size: int) -> list[dict[str, Any]]:
    if max_chunk_size < 1 or max_chunk_size > MAX_CHUNK_SIZE:
        raise ValueError(f"maxChunkSize must be between 1 and {MAX_CHUNK_SIZE}")

    chunk_count = max(1, math.ceil(len(data) / max_chunk_size))
    chunks = []
    for i in range(chunk_count):
        start = i * max_chunk_size
        end = min(start + max_chunk_size, len(data))
        payload = data[start:end]
        chunks.append(
            {
                "chunkIndex": i,
                "chunkCount": chunk_count,
                "chunkHash": _sha256_bytes(payload),
                "payload": payload,
            }
        )
    return chunks


def _reassemble_chunks(chunks: list[dict[str, Any]]) -> bytes:
    if not chunks:
        raise ChunkReassemblyError("No chunks provided")

    expected_count = chunks[0]["chunkCount"]
    if len(chunks) != expected_count:
        raise ChunkReassemblyError(
            f"Expected {expected_count} chunks, received {len(chunks)}"
        )

    sorted_chunks = sorted(chunks, key=lambda c: c["chunkIndex"])

    for i, chunk in enumerate(sorted_chunks):
        if chunk["chunkIndex"] != i:
            raise ChunkReassemblyError(f"Missing chunk at index {i}")
        if chunk["chunkCount"] != expected_count:
            raise ChunkReassemblyError(
                f"Inconsistent chunkCount: expected {expected_count}, "
                f"chunk {i} has {chunk['chunkCount']}"
            )
        actual_hash = _sha256_bytes(chunk["payload"])
        if actual_hash != chunk["chunkHash"]:
            raise ChunkIntegrityError(i, chunk["chunkHash"], actual_hash)

    return b"".join(c["payload"] for c in sorted_chunks)


def serialize_bundle(
    thoughtforms: list[dict[str, Any]],
    options: dict[str, Any],
    meta: dict[str, Any],
) -> dict[str, Any]:
    """Build a bundle from thoughtforms, serialize, compress, and chunk it.

    Returns ``{"manifest": {...}, "chunks": [...]}``.
    """
    compress_mode: str = options.get("compress", "none")
    chunk_max: int = options.get("chunkSizeMaxBytes", MAX_CHUNK_SIZE)

    # Canonical sort: updatedAtMs asc, id asc, contentHash asc
    def _sort_key(tf: dict[str, Any]) -> tuple[int, str, str]:
        md = tf.get("metadata", {})
        return (
            md.get("updatedAtMs", 0),
            tf.get("id", ""),
            md.get("contentHash", ""),
        )

    sorted_tfs = sorted(thoughtforms, key=_sort_key)

    now_ms = int(time.time() * 1000)
    bundle_id = f"bndl_{uuid.uuid4().hex[:16]}"

    updated_times = [
        tf.get("metadata", {}).get("updatedAtMs", 0) for tf in sorted_tfs
    ]
    until_ms = max(updated_times) if updated_times else now_ms

    bundle: dict[str, Any] = {
        "version": "1.0",
        "bundleId": bundle_id,
        "commit": {
            "commitId": "",  # placeholder, computed below
            "parentCommitId": meta.get("parentCommitId"),
            "createdAtMs": now_ms,
            "syncMode": "backup",
            "dedupeKey": "",  # placeholder
        },
        "manifest": {
            "bundleId": bundle_id,
            "thoughtformCount": len(sorted_tfs),
            "payloadHash": "",  # placeholder
            "compression": compress_mode,
            "encryption": "none",
            "chunkCount": 0,  # placeholder
            "chunkSizeMaxBytes": chunk_max,
        },
        "delta": {
            "sinceUpdatedAtMsExclusive": meta.get("sinceUpdatedAtMsExclusive", 0),
            "untilUpdatedAtMsInclusive": until_ms,
        },
        "thoughtforms": sorted_tfs,
        "extensions": {},
    }

    # Deterministic serialization
    canonical_json = _deterministic_json(bundle)
    payload_bytes = canonical_json.encode("utf-8")
    payload_hash = _sha256_str(canonical_json)

    bundle["manifest"]["payloadHash"] = payload_hash
    bundle["commit"]["commitId"] = f"cmt_{payload_hash[:16]}"
    bundle["commit"]["dedupeKey"] = _sha256_str(
        _deterministic_json(bundle["manifest"])
    )

    # Compress
    processed = _compress(payload_bytes, compress_mode)

    # Chunk
    raw_chunks = _chunk_payload(processed, chunk_max)

    bundle["manifest"]["chunkCount"] = len(raw_chunks)

    chunks_out = []
    for rc in raw_chunks:
        chunks_out.append(
            {
                "chunkIndex": rc["chunkIndex"],
                "chunkCount": rc["chunkCount"],
                "chunkHash": rc["chunkHash"],
                "payloadBase64": base64.b64encode(rc["payload"]).decode("ascii"),
            }
        )

    return {"manifest": bundle["manifest"], "chunks": chunks_out}


def deserialize_bundle(
    chunks_input: list[dict[str, Any]],
    options: dict[str, Any],
) -> dict[str, Any]:
    """Reassemble chunks, decompress, and parse the bundle JSON.

    Returns ``{"bundle": {...}, "diagnostics": [...]}``.
    """
    compression: str = options.get("compression", "none")
    diagnostics: list[str] = []

    # Decode base64 payloads
    decoded_chunks = []
    for c in chunks_input:
        payload = base64.b64decode(c["payloadBase64"])
        decoded_chunks.append(
            {
                "chunkIndex": c["chunkIndex"],
                "chunkCount": c["chunkCount"],
                "chunkHash": c["chunkHash"],
                "payload": payload,
            }
        )

    # Reassemble
    assembled = _reassemble_chunks(decoded_chunks)

    # Decompress
    decompressed = _decompress(assembled, compression)

    # Parse
    bundle = json.loads(decompressed.decode("utf-8"))
    diagnostics.append(f"reassembled {len(decoded_chunks)} chunks")

    return {"bundle": bundle, "diagnostics": diagnostics}


def rebuild_faiss_index(
    thoughtforms: list[dict[str, Any]],
    mode: str,
    get_model_fn: Any,
) -> dict[str, Any]:
    """Build or update a FAISS index from thoughtform text content.

    Returns ``{"rebuilt": True, "vectorCount": N}``.
    """
    import faiss
    import numpy as np

    # Extract text from thoughtforms
    texts: list[str] = []
    for tf in thoughtforms:
        parts: list[str] = []
        if tf.get("rawText"):
            parts.append(tf["rawText"])
        for ent in tf.get("entities", []):
            if ent.get("value"):
                parts.append(ent["value"])
        text = " ".join(parts) if parts else tf.get("id", "")
        texts.append(text)

    if not texts:
        return {"rebuilt": True, "vectorCount": 0}

    model = get_model_fn()
    embeddings = model.encode(texts, normalize_embeddings=True)
    embeddings = np.array(embeddings, dtype=np.float32)

    dim = embeddings.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)

    return {"rebuilt": True, "vectorCount": int(index.ntotal)}
