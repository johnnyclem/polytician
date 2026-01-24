"""
FAISS vector index for nearest neighbor search
"""

import faiss
import numpy as np
from typing import List, Dict, Tuple, Optional
import json
import os

VECTOR_DIMENSION = 768
INDEX_PATH = "../data/faiss.index"
ID_MAP_PATH = "../data/id_map.json"


class VectorIndex:
    """
    FAISS-based vector index for efficient similarity search.
    Uses IndexFlatIP (Inner Product) for cosine similarity with normalized vectors.
    """
    
    def __init__(self, dimension: int = VECTOR_DIMENSION):
        self.dimension = dimension
        self.index: Optional[faiss.IndexFlatIP] = None
        self.id_map: List[str] = []  # Maps FAISS internal IDs to concept IDs
        self._initialize()
    
    def _initialize(self):
        """Initialize or load the FAISS index."""
        if os.path.exists(INDEX_PATH) and os.path.exists(ID_MAP_PATH):
            self._load()
        else:
            self.index = faiss.IndexFlatIP(self.dimension)
            self.id_map = []
    
    def _load(self):
        """Load index and ID map from disk."""
        try:
            self.index = faiss.read_index(INDEX_PATH)
            with open(ID_MAP_PATH, "r") as f:
                self.id_map = json.load(f)
            print(f"Loaded FAISS index with {self.index.ntotal} vectors")
        except Exception as e:
            print(f"Error loading index: {e}, creating new index")
            self.index = faiss.IndexFlatIP(self.dimension)
            self.id_map = []
    
    def _save(self):
        """Persist index and ID map to disk."""
        os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)
        faiss.write_index(self.index, INDEX_PATH)
        with open(ID_MAP_PATH, "w") as f:
            json.dump(self.id_map, f)
    
    def _normalize(self, vectors: np.ndarray) -> np.ndarray:
        """L2 normalize vectors for cosine similarity via inner product."""
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1  # Avoid division by zero
        return vectors / norms
    
    def add(self, concept_id: str, vector: List[float]) -> bool:
        """
        Add a vector to the index.
        
        Args:
            concept_id: Unique identifier for the concept
            vector: 768-dimensional embedding vector
            
        Returns:
            True if successful
        """
        if self.index is None:
            self._initialize()
        
        # Check if concept already exists, remove if so
        if concept_id in self.id_map:
            self.remove(concept_id)
        
        # Normalize and add vector
        vec_array = np.array([vector], dtype=np.float32)
        vec_normalized = self._normalize(vec_array)
        
        self.index.add(vec_normalized)
        self.id_map.append(concept_id)
        
        self._save()
        return True
    
    def remove(self, concept_id: str) -> bool:
        """
        Remove a vector from the index.
        
        Note: FAISS IndexFlatIP doesn't support direct removal.
        We rebuild the index without the removed vector.
        
        Args:
            concept_id: Concept ID to remove
            
        Returns:
            True if found and removed
        """
        if concept_id not in self.id_map:
            return False
        
        idx = self.id_map.index(concept_id)
        
        # Get all vectors except the one to remove
        if self.index.ntotal > 1:
            all_vectors = faiss.rev_swig_ptr(
                self.index.get_xb(), self.index.ntotal * self.dimension
            ).reshape(self.index.ntotal, self.dimension).copy()
            
            new_vectors = np.delete(all_vectors, idx, axis=0)
            new_id_map = self.id_map[:idx] + self.id_map[idx + 1:]
            
            # Rebuild index
            self.index = faiss.IndexFlatIP(self.dimension)
            if len(new_vectors) > 0:
                self.index.add(new_vectors)
            self.id_map = new_id_map
        else:
            # Only one vector, just reset
            self.index = faiss.IndexFlatIP(self.dimension)
            self.id_map = []
        
        self._save()
        return True
    
    def search(self, vector: List[float], k: int = 5) -> List[Dict]:
        """
        Find k nearest neighbors to the query vector.
        
        Args:
            vector: Query vector (768 dimensions)
            k: Number of neighbors to return
            
        Returns:
            List of {id, distance} dictionaries, sorted by similarity (highest first)
        """
        if self.index is None or self.index.ntotal == 0:
            return []
        
        # Limit k to available vectors
        k = min(k, self.index.ntotal)
        
        vec_array = np.array([vector], dtype=np.float32)
        vec_normalized = self._normalize(vec_array)
        
        distances, indices = self.index.search(vec_normalized, k)
        
        results = []
        for dist, idx in zip(distances[0], indices[0]):
            if idx >= 0 and idx < len(self.id_map):
                results.append({
                    "id": self.id_map[idx],
                    "distance": float(dist)  # Cosine similarity (higher is better)
                })
        
        return results
    
    def get_stats(self) -> Dict:
        """Get index statistics."""
        return {
            "total_vectors": self.index.ntotal if self.index else 0,
            "dimension": self.dimension,
            "id_count": len(self.id_map)
        }


# Singleton instance
_index: Optional[VectorIndex] = None


def get_index() -> VectorIndex:
    """Get or create the singleton vector index."""
    global _index
    if _index is None:
        _index = VectorIndex()
    return _index
