"""Tests for the Python sidecar Flask app."""

import json
import pytest
from unittest.mock import patch, MagicMock
import numpy as np

from app import app, EmbedRequest


@pytest.fixture
def client():
    """Create a test client."""
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def mock_model():
    """Mock the SentenceTransformer model."""
    mock = MagicMock()
    mock.get_sentence_embedding_dimension.return_value = 384
    mock.encode.return_value = np.random.rand(2, 384).astype(np.float32)
    with patch("app.get_model", return_value=mock):
        yield mock


class TestHealth:
    def test_health_returns_ok(self, client, mock_model):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["status"] == "ok"
        assert data["dimension"] == 384

    def test_health_includes_model_name(self, client, mock_model):
        resp = client.get("/health")
        data = json.loads(resp.data)
        assert "model" in data


class TestEmbed:
    def test_embed_single_text(self, client, mock_model):
        mock_model.encode.return_value = np.random.rand(1, 384).astype(np.float32)
        resp = client.post(
            "/embed",
            data=json.dumps({"texts": ["hello world"]}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["embeddings"]) == 1
        assert data["dimension"] == 384

    def test_embed_multiple_texts(self, client, mock_model):
        mock_model.encode.return_value = np.random.rand(3, 384).astype(np.float32)
        resp = client.post(
            "/embed",
            data=json.dumps({"texts": ["a", "b", "c"]}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["embeddings"]) == 3

    def test_embed_empty_texts_rejected(self, client, mock_model):
        resp = client.post(
            "/embed",
            data=json.dumps({"texts": []}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_embed_no_json_body(self, client, mock_model):
        resp = client.post("/embed", data="not json", content_type="text/plain")
        assert resp.status_code == 400

    def test_embed_too_many_texts(self, client, mock_model):
        resp = client.post(
            "/embed",
            data=json.dumps({"texts": ["x"] * 101}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_embed_missing_texts_field(self, client, mock_model):
        resp = client.post(
            "/embed",
            data=json.dumps({"text": "wrong field"}),
            content_type="application/json",
        )
        assert resp.status_code == 400


class TestSimilarity:
    def test_similarity_returns_score(self, client, mock_model):
        vecs = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        mock_model.encode.return_value = vecs
        resp = client.post(
            "/similarity",
            data=json.dumps({"text_a": "cat", "text_b": "dog"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "similarity" in data
        assert isinstance(data["similarity"], float)

    def test_similarity_missing_text_a(self, client, mock_model):
        resp = client.post(
            "/similarity",
            data=json.dumps({"text_b": "dog"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_similarity_missing_text_b(self, client, mock_model):
        resp = client.post(
            "/similarity",
            data=json.dumps({"text_a": "cat"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_similarity_no_json(self, client, mock_model):
        resp = client.post("/similarity", data="bad", content_type="text/plain")
        assert resp.status_code == 400


class TestEmbedRequestValidation:
    def test_valid_request(self):
        req = EmbedRequest(texts=["hello"])
        assert req.texts == ["hello"]

    def test_empty_list_rejected(self):
        with pytest.raises(Exception):
            EmbedRequest(texts=[])

    def test_over_limit_rejected(self):
        with pytest.raises(Exception):
            EmbedRequest(texts=["x"] * 101)
