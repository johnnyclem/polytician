"""
Embedding service using sentence-transformers
Model: all-MiniLM-L6-v2 (768 dimensions)
"""

from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List, Optional

# Singleton model instance
_model: Optional[SentenceTransformer] = None

MODEL_NAME = "all-MiniLM-L6-v2"
VECTOR_DIMENSION = 768


def get_model() -> SentenceTransformer:
    """Get or initialize the embedding model (lazy loading)."""
    global _model
    if _model is None:
        print(f"Loading embedding model: {MODEL_NAME}...")
        _model = SentenceTransformer(MODEL_NAME)
        print("Embedding model loaded successfully.")
    return _model


def embed_text(text: str) -> List[float]:
    """
    Generate embedding vector for a single text.
    
    Args:
        text: Input text to embed
        
    Returns:
        List of floats (768 dimensions)
    """
    model = get_model()
    embedding = model.encode(text, convert_to_numpy=True)
    return embedding.tolist()


def embed_texts(texts: List[str]) -> List[List[float]]:
    """
    Generate embedding vectors for multiple texts (batch processing).
    
    Args:
        texts: List of input texts
        
    Returns:
        List of embedding vectors
    """
    model = get_model()
    embeddings = model.encode(texts, convert_to_numpy=True)
    return embeddings.tolist()


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """
    Compute cosine similarity between two vectors.
    
    Args:
        vec1: First vector
        vec2: Second vector
        
    Returns:
        Cosine similarity score (-1 to 1)
    """
    a = np.array(vec1)
    b = np.array(vec2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
