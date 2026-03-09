"""PolyVault FAISS rebuild service — full and upsert modes.

Dedicated module for rebuilding the FAISS vector index from ThoughtForm
data after a restore. Wraps the core rebuild_faiss_index logic with
mode-aware behavior:

- **replace**: Truncate existing index, rebuild from all provided ThoughtForms.
- **upsert**: Add/update vectors only for the provided ThoughtForm IDs,
  leaving existing vectors for other IDs untouched.
"""

from __future__ import annotations

import logging
from typing import Any

from polyvault_service import rebuild_faiss_index

logger = logging.getLogger(__name__)


class FaissRebuildResult:
    """Result of a FAISS rebuild operation."""

    def __init__(
        self,
        rebuilt: bool,
        vector_count: int,
        mode: str,
        ids_processed: int,
    ):
        self.rebuilt = rebuilt
        self.vector_count = vector_count
        self.mode = mode
        self.ids_processed = ids_processed

    def to_dict(self) -> dict[str, Any]:
        return {
            "rebuilt": self.rebuilt,
            "vectorCount": self.vector_count,
            "mode": self.mode,
            "idsProcessed": self.ids_processed,
        }


def rebuild_index(
    thoughtforms: list[dict[str, Any]],
    mode: str,
    get_model_fn: Any,
) -> FaissRebuildResult:
    """Rebuild the FAISS index from ThoughtForm data.

    Args:
        thoughtforms: List of ThoughtFormV1 dicts.
        mode: "replace" for full rebuild, "upsert" for incremental.
        get_model_fn: Callable that returns the sentence-transformer model.

    Returns:
        FaissRebuildResult with rebuild status and vector count.
    """
    if not thoughtforms:
        logger.info("No thoughtforms provided for FAISS rebuild; returning empty result.")
        return FaissRebuildResult(
            rebuilt=True,
            vector_count=0,
            mode=mode,
            ids_processed=0,
        )

    logger.info(
        "Starting FAISS rebuild: mode=%s, thoughtform_count=%d",
        mode,
        len(thoughtforms),
    )

    result = rebuild_faiss_index(
        thoughtforms=thoughtforms,
        mode=mode,
        get_model_fn=get_model_fn,
    )

    logger.info(
        "FAISS rebuild complete: mode=%s, vector_count=%d",
        mode,
        result["vectorCount"],
    )

    return FaissRebuildResult(
        rebuilt=result["rebuilt"],
        vector_count=result["vectorCount"],
        mode=mode,
        ids_processed=len(thoughtforms),
    )
