"""Polytician Python Sidecar — ML embedding and NLP services."""

import os
import logging
from typing import Any

import numpy as np
from flask import Flask, jsonify, request
from pydantic import BaseModel, field_validator
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
model: SentenceTransformer | None = None


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


# --- PolyVault routes (gated by POLYVAULT_ENABLED) ---
if os.environ.get("POLYVAULT_ENABLED", "").lower() in ("1", "true", "yes"):
    from polyvault_routes import init_polyvault, polyvault_bp

    init_polyvault(get_model)
    app.register_blueprint(polyvault_bp)


if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", "5001"))
    app.run(host="0.0.0.0", port=port)
