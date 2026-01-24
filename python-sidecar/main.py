"""
Python Sidecar Service for Politician MCP Server

FastAPI server providing:
- Text embedding generation (sentence-transformers)
- Named Entity Recognition (spaCy)
- Vector similarity search (FAISS)

Runs on localhost:8787 by default.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import uvicorn

from embeddings import embed_text, embed_texts
from ner import extract_entities, extract_relationships, analyze_text, build_context_graph
from vector_index import get_index

app = FastAPI(
    title="Politician Sidecar",
    description="ML services for the Politician MCP server",
    version="1.0.0"
)


# ============ Request/Response Models ============

class EmbedRequest(BaseModel):
    text: str


class EmbedBatchRequest(BaseModel):
    texts: List[str]


class EmbedResponse(BaseModel):
    vector: List[float]
    dimension: int


class EmbedBatchResponse(BaseModel):
    vectors: List[List[float]]
    dimension: int
    count: int


class NERRequest(BaseModel):
    text: str


class Entity(BaseModel):
    id: str
    text: str
    type: str
    confidence: float
    offset: Dict[str, int]


class Relationship(BaseModel):
    subjectId: str
    predicate: str
    objectId: str
    confidence: Optional[float] = None


class NERResponse(BaseModel):
    entities: List[Entity]
    relationships: List[Relationship]
    context_graph: Dict[str, List[str]]


class SearchRequest(BaseModel):
    vector: List[float]
    k: int = 5


class SearchResult(BaseModel):
    id: str
    distance: float


class SearchResponse(BaseModel):
    neighbors: List[SearchResult]
    query_dimension: int


class IndexAddRequest(BaseModel):
    concept_id: str
    vector: List[float]


class IndexRemoveRequest(BaseModel):
    concept_id: str


class SummarizeRequest(BaseModel):
    concept_ids: List[str]
    vectors: Optional[List[List[float]]] = None
    texts: Optional[List[str]] = None


class SummarizeResponse(BaseModel):
    markdown: str


class HealthResponse(BaseModel):
    status: str
    services: Dict[str, bool]
    index_stats: Dict[str, Any]


# ============ Endpoints ============

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check if all services are operational."""
    index = get_index()
    
    return HealthResponse(
        status="ok",
        services={
            "embeddings": True,
            "ner": True,
            "vector_index": True
        },
        index_stats=index.get_stats()
    )


@app.post("/embed", response_model=EmbedResponse)
async def embed_single(request: EmbedRequest):
    """Generate embedding for a single text."""
    try:
        vector = embed_text(request.text)
        return EmbedResponse(
            vector=vector,
            dimension=len(vector)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed-batch", response_model=EmbedBatchResponse)
async def embed_batch(request: EmbedBatchRequest):
    """Generate embeddings for multiple texts."""
    try:
        vectors = embed_texts(request.texts)
        return EmbedBatchResponse(
            vectors=vectors,
            dimension=len(vectors[0]) if vectors else 0,
            count=len(vectors)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract-ner", response_model=NERResponse)
async def extract_ner(request: NERRequest):
    """Extract named entities and relationships from text."""
    try:
        result = analyze_text(request.text)
        return NERResponse(
            entities=result["entities"],
            relationships=result["relationships"],
            context_graph=result["context_graph"]
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search-nn", response_model=SearchResponse)
async def search_nearest_neighbors(request: SearchRequest):
    """Find k nearest neighbors to a query vector."""
    try:
        index = get_index()
        neighbors = index.search(request.vector, request.k)
        return SearchResponse(
            neighbors=[SearchResult(**n) for n in neighbors],
            query_dimension=len(request.vector)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/add")
async def add_to_index(request: IndexAddRequest):
    """Add a vector to the FAISS index."""
    try:
        index = get_index()
        success = index.add(request.concept_id, request.vector)
        return {"success": success, "concept_id": request.concept_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/remove")
async def remove_from_index(request: IndexRemoveRequest):
    """Remove a vector from the FAISS index."""
    try:
        index = get_index()
        success = index.remove(request.concept_id)
        return {"success": success, "concept_id": request.concept_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/index/stats")
async def get_index_stats():
    """Get FAISS index statistics."""
    index = get_index()
    return index.get_stats()


@app.post("/summarize", response_model=SummarizeResponse)
async def summarize_concepts(request: SummarizeRequest):
    """
    Generate a markdown summary from concept data.
    
    This is a placeholder implementation. For production, you would:
    1. Use a language model to generate natural text from vectors
    2. Or retrieve and combine markdown from nearest neighbors
    """
    try:
        parts = []
        
        if request.texts:
            # If we have text, just combine them
            parts.append("## Summary\n")
            for i, text in enumerate(request.texts):
                parts.append(f"- {text[:200]}{'...' if len(text) > 200 else ''}\n")
        elif request.concept_ids:
            # Generate a placeholder summary
            parts.append("## Concept Summary\n")
            parts.append(f"Based on {len(request.concept_ids)} related concepts:\n\n")
            for cid in request.concept_ids[:5]:  # Limit to 5
                parts.append(f"- Concept `{cid[:8]}...`\n")
        
        if not parts:
            parts.append("## Summary\n\n*No content available for summarization.*\n")
        
        return SummarizeResponse(markdown="".join(parts))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ Startup ============

@app.on_event("startup")
async def startup_event():
    """Pre-load models on startup for faster first request."""
    print("Starting Politician Sidecar...")
    
    # Initialize FAISS index
    index = get_index()
    print(f"FAISS index ready: {index.get_stats()}")
    
    # Models are loaded lazily on first use
    print("Sidecar ready. Models will load on first use.")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8787,
        reload=False,
        log_level="info"
    )
