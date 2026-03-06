"""Flask Blueprint for PolyVault sidecar endpoints."""

from __future__ import annotations

import logging
from typing import Any

from flask import Blueprint, jsonify, request

from polyvault_models import (
    DeserializeRequest,
    RebuildRequest,
    SerializeRequest,
)
from polyvault_service import (
    ChunkIntegrityError,
    ChunkReassemblyError,
    deserialize_bundle,
    rebuild_faiss_index,
    serialize_bundle,
)

logger = logging.getLogger(__name__)

polyvault_bp = Blueprint("polyvault", __name__, url_prefix="/polyvault")

# Injected at registration time by app.py
_get_model_fn: Any = None


def init_polyvault(get_model_fn: Any) -> None:
    global _get_model_fn
    _get_model_fn = get_model_fn


@polyvault_bp.route("/bundles/serialize", methods=["POST"])
def bundles_serialize() -> tuple[Any, int]:
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Request body must be JSON", "code": "ERR_VALIDATION"}), 400

    try:
        req = SerializeRequest(**data)
    except Exception as e:
        return jsonify({"error": str(e), "code": "ERR_VALIDATION"}), 400

    try:
        result = serialize_bundle(
            thoughtforms=[tf for tf in req.thoughtforms],
            options=req.options.model_dump(),
            meta=req.meta.model_dump(),
        )
    except ValueError as e:
        return jsonify({"error": str(e), "code": "ERR_CHUNK_LIMIT"}), 413
    except Exception as e:
        logger.exception("Serialization error")
        return jsonify({"error": str(e), "code": "ERR_SERIALIZE"}), 500

    return jsonify(result), 200


@polyvault_bp.route("/bundles/deserialize", methods=["POST"])
def bundles_deserialize() -> tuple[Any, int]:
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Request body must be JSON", "code": "ERR_VALIDATION"}), 400

    try:
        req = DeserializeRequest(**data)
    except Exception as e:
        return jsonify({"error": str(e), "code": "ERR_VALIDATION"}), 400

    try:
        result = deserialize_bundle(
            chunks_input=[c.model_dump() for c in req.chunks],
            options=req.options.model_dump(),
        )
    except ChunkIntegrityError as e:
        return jsonify({"error": str(e), "code": "ERR_HASH_MISMATCH"}), 422
    except ChunkReassemblyError as e:
        return jsonify({"error": str(e), "code": "ERR_REASSEMBLY"}), 422
    except Exception as e:
        logger.exception("Deserialization error")
        return jsonify({"error": str(e), "code": "ERR_VALIDATION"}), 400

    return jsonify(result), 200


@polyvault_bp.route("/faiss/rebuild", methods=["POST"])
def faiss_rebuild() -> tuple[Any, int]:
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Request body must be JSON", "code": "ERR_VALIDATION"}), 400

    try:
        req = RebuildRequest(**data)
    except Exception as e:
        return jsonify({"error": str(e), "code": "ERR_VALIDATION"}), 400

    if _get_model_fn is None:
        return jsonify({"error": "Model not initialized", "code": "ERR_SERIALIZE"}), 500

    try:
        result = rebuild_faiss_index(
            thoughtforms=req.thoughtforms,
            mode=req.mode,
            get_model_fn=_get_model_fn,
        )
    except Exception as e:
        logger.exception("FAISS rebuild error")
        return jsonify({"error": str(e), "code": "ERR_SERIALIZE"}), 500

    return jsonify(result), 200
