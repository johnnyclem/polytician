"""Tests for PolyVault sidecar routes."""

import base64
import hashlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Enable PolyVault routes for tests
os.environ["POLYVAULT_ENABLED"] = "true"

# Mock heavy ML dependencies before importing app
_mock_st = MagicMock()
sys.modules["sentence_transformers"] = _mock_st
_mock_faiss = MagicMock()
sys.modules["faiss"] = _mock_faiss

import numpy as np  # noqa: E402

from polyvault_service import (  # noqa: E402
    ChunkIntegrityError,
    ChunkReassemblyError,
    _chunk_payload,
    _deterministic_json,
    _reassemble_chunks,
    _sha256_bytes,
    _sha256_str,
    deserialize_bundle,
    serialize_bundle,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_thoughtform(tf_id: str = "tf_1", updated_at: int = 1700000000000) -> dict:
    return {
        "schemaVersion": "1.0",
        "id": tf_id,
        "entities": [{"id": "e1", "type": "concept", "value": "test entity"}],
        "relationships": [],
        "contextGraph": {},
        "metadata": {
            "createdAtMs": 1699000000000,
            "updatedAtMs": updated_at,
            "source": "local",
            "contentHash": hashlib.sha256(tf_id.encode()).hexdigest(),
            "redaction": {"rawTextOmitted": False},
        },
    }


@pytest.fixture
def mock_model():
    mock = MagicMock()
    mock.get_sentence_embedding_dimension.return_value = 384
    mock.encode.return_value = np.random.rand(1, 384).astype(np.float32)
    return mock


@pytest.fixture
def client(mock_model):
    with patch("app.get_model", return_value=mock_model), \
         patch("polyvault_routes._get_model_fn", return_value=mock_model):
        from app import app
        app.config["TESTING"] = True
        with app.test_client() as c:
            yield c


# ---------------------------------------------------------------------------
# Unit tests — service layer
# ---------------------------------------------------------------------------

class TestDeterministicJson:
    def test_sorted_keys(self):
        obj = {"z": 1, "a": 2, "m": 3}
        result = _deterministic_json(obj)
        assert result == '{"a":2,"m":3,"z":1}'

    def test_nested_sorted_keys(self):
        obj = {"b": {"z": 1, "a": 2}, "a": 1}
        result = _deterministic_json(obj)
        assert result == '{"a":1,"b":{"a":2,"z":1}}'

    def test_arrays_preserved_order(self):
        obj = {"arr": [3, 1, 2]}
        result = _deterministic_json(obj)
        assert result == '{"arr":[3,1,2]}'

    def test_deterministic_across_calls(self):
        obj = {"z": 1, "a": {"c": 3, "b": 2}}
        assert _deterministic_json(obj) == _deterministic_json(obj)


class TestSha256:
    def test_bytes_hash(self):
        h = _sha256_bytes(b"hello")
        assert len(h) == 64
        assert h == hashlib.sha256(b"hello").hexdigest()

    def test_str_hash(self):
        h = _sha256_str("hello")
        assert len(h) == 64
        assert h == hashlib.sha256(b"hello").hexdigest()


class TestChunkPayload:
    def test_single_chunk(self):
        data = b"x" * 100
        chunks = _chunk_payload(data, 1_000_000)
        assert len(chunks) == 1
        assert chunks[0]["chunkIndex"] == 0
        assert chunks[0]["chunkCount"] == 1
        assert chunks[0]["payload"] == data

    def test_multiple_chunks(self):
        data = b"x" * 300
        chunks = _chunk_payload(data, 100)
        assert len(chunks) == 3
        for i, c in enumerate(chunks):
            assert c["chunkIndex"] == i
            assert c["chunkCount"] == 3

    def test_chunk_hash_valid(self):
        data = b"test data"
        chunks = _chunk_payload(data, 1_000_000)
        expected = hashlib.sha256(data).hexdigest()
        assert chunks[0]["chunkHash"] == expected

    def test_invalid_max_size(self):
        with pytest.raises(ValueError):
            _chunk_payload(b"x", 0)
        with pytest.raises(ValueError):
            _chunk_payload(b"x", 1_000_001)

    def test_chunk_size_never_exceeds_max(self):
        data = b"x" * 2500
        chunks = _chunk_payload(data, 1000)
        for c in chunks:
            assert len(c["payload"]) <= 1000


class TestReassembleChunks:
    def test_roundtrip(self):
        data = b"hello world " * 100
        chunks = _chunk_payload(data, 500)
        result = _reassemble_chunks(chunks)
        assert result == data

    def test_out_of_order(self):
        data = b"hello world " * 100
        chunks = _chunk_payload(data, 500)
        reversed_chunks = list(reversed(chunks))
        result = _reassemble_chunks(reversed_chunks)
        assert result == data

    def test_empty_chunks_error(self):
        with pytest.raises(ChunkReassemblyError, match="No chunks"):
            _reassemble_chunks([])

    def test_missing_chunk_error(self):
        data = b"x" * 300
        chunks = _chunk_payload(data, 100)
        del chunks[1]  # remove middle chunk
        with pytest.raises(ChunkReassemblyError, match="Expected 3 chunks"):
            _reassemble_chunks(chunks)

    def test_hash_mismatch_error(self):
        data = b"test"
        chunks = _chunk_payload(data, 1_000_000)
        chunks[0]["chunkHash"] = "badhash"
        with pytest.raises(ChunkIntegrityError):
            _reassemble_chunks(chunks)


class TestSerializeDeserializeRoundtrip:
    def test_basic_roundtrip(self):
        tfs = [_make_thoughtform("tf_1"), _make_thoughtform("tf_2")]
        result = serialize_bundle(
            thoughtforms=tfs,
            options={"compress": "none", "chunkSizeMaxBytes": 1_000_000},
            meta={"parentCommitId": None, "sinceUpdatedAtMsExclusive": 0},
        )
        assert result["manifest"]["thoughtformCount"] == 2
        assert result["manifest"]["chunkCount"] == len(result["chunks"])
        assert result["manifest"]["compression"] == "none"

        # Deserialize
        deserialized = deserialize_bundle(
            chunks_input=result["chunks"],
            options={"compression": "none"},
        )
        bundle = deserialized["bundle"]
        assert len(bundle["thoughtforms"]) == 2

    def test_gzip_roundtrip(self):
        tfs = [_make_thoughtform(f"tf_{i}") for i in range(10)]
        result = serialize_bundle(
            thoughtforms=tfs,
            options={"compress": "gzip", "chunkSizeMaxBytes": 1_000_000},
            meta={"parentCommitId": None, "sinceUpdatedAtMsExclusive": 0},
        )
        assert result["manifest"]["compression"] == "gzip"

        deserialized = deserialize_bundle(
            chunks_input=result["chunks"],
            options={"compression": "gzip"},
        )
        bundle = deserialized["bundle"]
        assert len(bundle["thoughtforms"]) == 10

    def test_multi_chunk_roundtrip(self):
        tfs = [_make_thoughtform(f"tf_{i}") for i in range(50)]
        result = serialize_bundle(
            thoughtforms=tfs,
            options={"compress": "none", "chunkSizeMaxBytes": 2000},
            meta={},
        )
        assert result["manifest"]["chunkCount"] > 1

        deserialized = deserialize_bundle(
            chunks_input=result["chunks"],
            options={"compression": "none"},
        )
        assert len(deserialized["bundle"]["thoughtforms"]) == 50

    def test_canonical_sort_order(self):
        tf_late = _make_thoughtform("aaa", updated_at=2000000000000)
        tf_early = _make_thoughtform("zzz", updated_at=1000000000000)
        result = serialize_bundle(
            thoughtforms=[tf_late, tf_early],
            options={"compress": "none", "chunkSizeMaxBytes": 1_000_000},
            meta={},
        )
        deserialized = deserialize_bundle(
            chunks_input=result["chunks"],
            options={"compression": "none"},
        )
        tfs = deserialized["bundle"]["thoughtforms"]
        assert tfs[0]["id"] == "zzz"  # earlier updatedAtMs comes first
        assert tfs[1]["id"] == "aaa"


# ---------------------------------------------------------------------------
# Route tests — /polyvault/bundles/serialize
# ---------------------------------------------------------------------------

class TestSerializeRoute:
    def test_serialize_success(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform()],
                "options": {"compress": "none", "chunkSizeMaxBytes": 1000000},
                "meta": {"parentCommitId": None, "sinceUpdatedAtMsExclusive": 0},
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "manifest" in data
        assert "chunks" in data
        assert data["manifest"]["thoughtformCount"] == 1
        assert data["manifest"]["chunkCount"] == len(data["chunks"])

    def test_serialize_with_gzip(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform()],
                "options": {"compress": "gzip"},
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["manifest"]["compression"] == "gzip"

    def test_serialize_default_options(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({"thoughtforms": [_make_thoughtform()]}),
            content_type="application/json",
        )
        assert resp.status_code == 200

    def test_serialize_empty_thoughtforms_rejected(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({"thoughtforms": []}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data = json.loads(resp.data)
        assert data["code"] == "ERR_VALIDATION"

    def test_serialize_no_json_body(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data="not json",
            content_type="text/plain",
        )
        assert resp.status_code == 400

    def test_serialize_invalid_chunk_size(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform()],
                "options": {"chunkSizeMaxBytes": 2000000},
            }),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data = json.loads(resp.data)
        assert data["code"] == "ERR_VALIDATION"

    def test_serialize_chunks_have_base64(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({"thoughtforms": [_make_thoughtform()]}),
            content_type="application/json",
        )
        data = json.loads(resp.data)
        for chunk in data["chunks"]:
            decoded = base64.b64decode(chunk["payloadBase64"])
            assert len(decoded) > 0

    def test_serialize_manifest_fields(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({"thoughtforms": [_make_thoughtform()]}),
            content_type="application/json",
        )
        data = json.loads(resp.data)
        manifest = data["manifest"]
        assert "bundleId" in manifest
        assert "payloadHash" in manifest
        assert len(manifest["payloadHash"]) == 64
        assert manifest["encryption"] == "none"


# ---------------------------------------------------------------------------
# Route tests — /polyvault/bundles/deserialize
# ---------------------------------------------------------------------------

class TestDeserializeRoute:
    def _serialize_first(self, client) -> dict:
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform("tf_a"), _make_thoughtform("tf_b")],
                "options": {"compress": "none"},
            }),
            content_type="application/json",
        )
        return json.loads(resp.data)

    def test_deserialize_success(self, client):
        serialized = self._serialize_first(client)
        resp = client.post(
            "/polyvault/bundles/deserialize",
            data=json.dumps({
                "chunks": serialized["chunks"],
                "options": {"compression": "none"},
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "bundle" in data
        assert "diagnostics" in data
        assert len(data["bundle"]["thoughtforms"]) == 2

    def test_deserialize_gzip_roundtrip(self, client):
        resp = client.post(
            "/polyvault/bundles/serialize",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform()],
                "options": {"compress": "gzip"},
            }),
            content_type="application/json",
        )
        serialized = json.loads(resp.data)

        resp = client.post(
            "/polyvault/bundles/deserialize",
            data=json.dumps({
                "chunks": serialized["chunks"],
                "options": {"compression": "gzip"},
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["bundle"]["thoughtforms"]) == 1

    def test_deserialize_empty_chunks_rejected(self, client):
        resp = client.post(
            "/polyvault/bundles/deserialize",
            data=json.dumps({"chunks": [], "options": {"compression": "none"}}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data = json.loads(resp.data)
        assert data["code"] == "ERR_VALIDATION"

    def test_deserialize_hash_mismatch(self, client):
        serialized = self._serialize_first(client)
        serialized["chunks"][0]["chunkHash"] = "0" * 64
        resp = client.post(
            "/polyvault/bundles/deserialize",
            data=json.dumps({
                "chunks": serialized["chunks"],
                "options": {"compression": "none"},
            }),
            content_type="application/json",
        )
        assert resp.status_code == 422
        data = json.loads(resp.data)
        assert data["code"] == "ERR_HASH_MISMATCH"

    def test_deserialize_bad_base64(self, client):
        resp = client.post(
            "/polyvault/bundles/deserialize",
            data=json.dumps({
                "chunks": [{
                    "chunkIndex": 0,
                    "chunkCount": 1,
                    "chunkHash": "a" * 64,
                    "payloadBase64": "!!!not-base64!!!",
                }],
                "options": {"compression": "none"},
            }),
            content_type="application/json",
        )
        assert resp.status_code in (400, 422)

    def test_deserialize_no_json(self, client):
        resp = client.post(
            "/polyvault/bundles/deserialize",
            data="bad",
            content_type="text/plain",
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Route tests — /polyvault/faiss/rebuild
# ---------------------------------------------------------------------------

class TestFaissRebuildRoute:
    def test_rebuild_replace(self, client, mock_model):
        mock_index = MagicMock()
        mock_index.ntotal = 2
        _mock_faiss.IndexFlatIP.return_value = mock_index
        mock_model.encode.return_value = np.random.rand(2, 384).astype(np.float32)

        resp = client.post(
            "/polyvault/faiss/rebuild",
            data=json.dumps({
                "thoughtforms": [
                    _make_thoughtform("tf_1"),
                    _make_thoughtform("tf_2"),
                ],
                "mode": "replace",
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["rebuilt"] is True
        assert data["vectorCount"] == 2

    def test_rebuild_upsert(self, client, mock_model):
        mock_index = MagicMock()
        mock_index.ntotal = 1
        _mock_faiss.IndexFlatIP.return_value = mock_index
        mock_model.encode.return_value = np.random.rand(1, 384).astype(np.float32)

        resp = client.post(
            "/polyvault/faiss/rebuild",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform()],
                "mode": "upsert",
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["rebuilt"] is True

    def test_rebuild_no_json(self, client):
        resp = client.post(
            "/polyvault/faiss/rebuild",
            data="bad",
            content_type="text/plain",
        )
        assert resp.status_code == 400

    def test_rebuild_invalid_mode(self, client):
        resp = client.post(
            "/polyvault/faiss/rebuild",
            data=json.dumps({
                "thoughtforms": [_make_thoughtform()],
                "mode": "invalid",
            }),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data = json.loads(resp.data)
        assert data["code"] == "ERR_VALIDATION"

    def test_rebuild_empty_thoughtforms(self, client, mock_model):
        resp = client.post(
            "/polyvault/faiss/rebuild",
            data=json.dumps({"thoughtforms": [], "mode": "replace"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["rebuilt"] is True
        assert data["vectorCount"] == 0

    def test_rebuild_extracts_entity_values(self, client, mock_model):
        mock_index = MagicMock()
        mock_index.ntotal = 1
        _mock_faiss.IndexFlatIP.return_value = mock_index
        mock_model.encode.return_value = np.random.rand(1, 384).astype(np.float32)

        tf = _make_thoughtform()
        tf["rawText"] = "some raw text"

        resp = client.post(
            "/polyvault/faiss/rebuild",
            data=json.dumps({"thoughtforms": [tf], "mode": "replace"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        # Verify encode was called with combined text
        call_args = mock_model.encode.call_args
        texts = call_args[0][0]
        assert "some raw text" in texts[0]
        assert "test entity" in texts[0]
