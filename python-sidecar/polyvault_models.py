"""Pydantic models for PolyVault sidecar endpoints."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class SerializeOptions(BaseModel):
    compress: Literal["none", "gzip"] = "none"
    encrypt: Literal["none"] = "none"
    chunkSizeMaxBytes: int = Field(default=1_000_000, gt=0, le=1_000_000)


class SerializeMeta(BaseModel):
    parentCommitId: str | None = None
    sinceUpdatedAtMsExclusive: int = 0


class SerializeRequest(BaseModel):
    thoughtforms: list[dict[str, Any]]
    options: SerializeOptions = SerializeOptions()
    meta: SerializeMeta = SerializeMeta()

    @field_validator("thoughtforms")
    @classmethod
    def thoughtforms_non_empty(cls, v: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not v:
            raise ValueError("thoughtforms must be a non-empty list")
        return v


class ChunkResponse(BaseModel):
    chunkIndex: int
    chunkCount: int
    chunkHash: str
    payloadBase64: str


class ManifestResponse(BaseModel):
    bundleId: str
    thoughtformCount: int
    payloadHash: str
    compression: str
    encryption: str
    chunkCount: int
    chunkSizeMaxBytes: int


class SerializeResponse(BaseModel):
    manifest: ManifestResponse
    chunks: list[ChunkResponse]


class ChunkInput(BaseModel):
    chunkIndex: int = Field(ge=0)
    chunkCount: int = Field(gt=0)
    chunkHash: str = Field(min_length=1)
    payloadBase64: str = Field(min_length=1)


class DeserializeOptions(BaseModel):
    compression: Literal["none", "gzip"] = "none"


class DeserializeRequest(BaseModel):
    chunks: list[ChunkInput]
    options: DeserializeOptions = DeserializeOptions()

    @field_validator("chunks")
    @classmethod
    def chunks_non_empty(cls, v: list[ChunkInput]) -> list[ChunkInput]:
        if not v:
            raise ValueError("chunks must be a non-empty list")
        return v


class DeserializeResponse(BaseModel):
    bundle: dict[str, Any]
    diagnostics: list[str]


class RebuildRequest(BaseModel):
    thoughtforms: list[dict[str, Any]]
    mode: Literal["replace", "upsert"] = "replace"


class RebuildResponse(BaseModel):
    rebuilt: bool
    vectorCount: int


class ErrorResponse(BaseModel):
    error: str
    code: str
