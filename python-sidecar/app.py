"""Polytician Python Sidecar — ML embedding and NLP services."""

import os
import logging
from typing import Any

import faiss
import numpy as np
from flask import Flask, jsonify, request
from pydantic import BaseModel, field_validator
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
model: SentenceTransformer | None = None

# FAISS index state: maps string IDs to integer positions
faiss_index: faiss.IndexFlatIP | None = None
faiss_id_map: list[str] = []


def get_model() -> SentenceTransformer:
    """Lazy-load the sentence-transformers model."""
    global model
    if model is None:
        logger.info("Loading model: %s", MODEL_NAME)
        model = SentenceTransformer(MODEL_NAME)
        logger.info("Model loaded successfully")
    return model


class EmbedRequest(BaseModel):
    texts: list[str]

    @field_validator("texts")
    @classmethod
    def texts_non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("texts must be a non-empty list")
        if len(v) > 100:
            raise ValueError("texts must contain at most 100 items")
        return v


class RebuildIndexRequest(BaseModel):
    ids: list[str]
    texts: list[str]

    @field_validator("ids")
    @classmethod
    def ids_non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("ids must be a non-empty list")
        return v

    @field_validator("texts")
    @classmethod
    def texts_match_ids(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("texts must be a non-empty list")
        return v


class HealthResponse(BaseModel):
    status: str
    model: str
    dimension: int


@app.route("/health", methods=["GET"])
def health() -> tuple[Any, int]:
    """Health check endpoint."""
    m = get_model()
    dim = m.get_sentence_embedding_dimension()
    resp = HealthResponse(status="ok", model=MODEL_NAME, dimension=dim)
    return jsonify(resp.model_dump()), 200


@app.route("/embed", methods=["POST"])
def embed() -> tuple[Any, int]:
    """Generate embeddings for a list of texts."""
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Request body must be JSON"}), 400

    try:
        req = EmbedRequest(**data)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    m = get_model()
    embeddings = m.encode(req.texts, normalize_embeddings=True)

    return jsonify({
        "embeddings": [e.tolist() for e in embeddings],
        "dimension": int(embeddings.shape[1]),
        "model": MODEL_NAME,
    }), 200


@app.route("/similarity", methods=["POST"])
def similarity() -> tuple[Any, int]:
    """Compute cosine similarity between two texts."""
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Request body must be JSON"}), 400

    text_a = data.get("text_a")
    text_b = data.get("text_b")
    if not text_a or not text_b:
        return jsonify({"error": "text_a and text_b are required"}), 400

    m = get_model()
    embeddings = m.encode([text_a, text_b], normalize_embeddings=True)
    score = float(np.dot(embeddings[0], embeddings[1]))

    return jsonify({"similarity": score}), 200


@app.route("/rebuild-index", methods=["POST"])
def rebuild_index() -> tuple[Any, int]:
    """Rebuild FAISS index with embeddings for the given ThoughtForm IDs.

    Accepts a list of IDs and their corresponding texts, generates embeddings,
    and rebuilds the in-memory FAISS index so new vectors are searchable.
    """
    global faiss_index, faiss_id_map

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Request body must be JSON"}), 400

    try:
        req = RebuildIndexRequest(**data)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    if len(req.ids) != len(req.texts):
        return jsonify({"error": "ids and texts must have the same length"}), 400

    m = get_model()
    dim = int(m.get_sentence_embedding_dimension())

    # Generate normalized embeddings for the new/updated texts
    embeddings = m.encode(req.texts, normalize_embeddings=True)
    new_vectors = np.array(embeddings, dtype=np.float32)

    if faiss_index is None:
        # First build: create a fresh index
        faiss_index = faiss.IndexFlatIP(dim)
        faiss_id_map = []

    # Remove existing entries for IDs being rebuilt (if any)
    ids_to_add = set(req.ids)
    existing_positions = [i for i, fid in enumerate(faiss_id_map) if fid in ids_to_add]

    if existing_positions:
        # Rebuild index without the stale vectors, then add new ones
        keep_mask = np.ones(faiss_index.ntotal, dtype=bool)
        keep_mask[existing_positions] = False
        keep_indices = np.where(keep_mask)[0]

        if len(keep_indices) > 0:
            kept_vectors = np.array(
                [faiss_index.reconstruct(int(i)) for i in keep_indices],
                dtype=np.float32,
            )
            kept_ids = [faiss_id_map[int(i)] for i in keep_indices]
            faiss_index = faiss.IndexFlatIP(dim)
            faiss_index.add(kept_vectors)
            faiss_id_map = kept_ids
        else:
            faiss_index = faiss.IndexFlatIP(dim)
            faiss_id_map = []

    # Add the new/updated vectors
    faiss_index.add(new_vectors)
    faiss_id_map.extend(req.ids)

    logger.info(
        "FAISS index rebuilt: added %d vectors, total %d",
        len(req.ids),
        faiss_index.ntotal,
    )

    return jsonify({
        "status": "ok",
        "indexed_ids": req.ids,
        "total_vectors": int(faiss_index.ntotal),
        "dimension": dim,
    }), 200


if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", "5001"))
    app.run(host="0.0.0.0", port=port)
