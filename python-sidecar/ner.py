"""
Named Entity Recognition service using spaCy
Model: en_core_web_sm (or en_core_web_md for better accuracy)
"""

import spacy
from typing import List, Optional, Dict, Any
import subprocess
import sys

# Singleton NLP instance
_nlp: Optional[spacy.Language] = None

MODEL_NAME = "en_core_web_sm"


def ensure_model_downloaded():
    """Download spaCy model if not present."""
    try:
        spacy.load(MODEL_NAME)
    except OSError:
        print(f"Downloading spaCy model: {MODEL_NAME}...")
        subprocess.check_call([
            sys.executable, "-m", "spacy", "download", MODEL_NAME
        ])
        print("spaCy model downloaded successfully.")


def get_nlp() -> spacy.Language:
    """Get or initialize the spaCy NLP pipeline (lazy loading)."""
    global _nlp
    if _nlp is None:
        ensure_model_downloaded()
        print(f"Loading spaCy model: {MODEL_NAME}...")
        _nlp = spacy.load(MODEL_NAME)
        print("spaCy model loaded successfully.")
    return _nlp


def extract_entities(text: str) -> List[Dict[str, Any]]:
    """
    Extract named entities from text.
    
    Args:
        text: Input text to analyze
        
    Returns:
        List of entity dictionaries with:
        - id: Unique identifier for the entity
        - text: The entity text
        - type: Entity type (PERSON, ORG, GPE, DATE, etc.)
        - confidence: Confidence score (spaCy doesn't provide this, so we use 1.0)
        - offset: {start, end} character positions
    """
    nlp = get_nlp()
    doc = nlp(text)
    
    entities = []
    for i, ent in enumerate(doc.ents):
        entities.append({
            "id": f"ent_{i}",
            "text": ent.text,
            "type": ent.label_,
            "confidence": 1.0,  # spaCy doesn't provide confidence scores
            "offset": {
                "start": ent.start_char,
                "end": ent.end_char
            }
        })
    
    return entities


def extract_relationships(text: str) -> List[Dict[str, Any]]:
    """
    Extract simple relationships between entities based on syntactic dependencies.
    
    This is a basic implementation that finds subject-verb-object patterns.
    For more sophisticated relation extraction, consider using a dedicated RE model.
    
    Args:
        text: Input text to analyze
        
    Returns:
        List of relationship dictionaries
    """
    nlp = get_nlp()
    doc = nlp(text)
    
    relationships = []
    entities = {ent.text: f"ent_{i}" for i, ent in enumerate(doc.ents)}
    
    # Find subject-verb-object patterns
    for token in doc:
        if token.dep_ == "ROOT" and token.pos_ == "VERB":
            subject = None
            obj = None
            
            for child in token.children:
                if child.dep_ in ("nsubj", "nsubjpass"):
                    # Check if subject is an entity
                    for ent in doc.ents:
                        if child.i >= ent.start and child.i < ent.end:
                            subject = entities.get(ent.text)
                            break
                elif child.dep_ in ("dobj", "pobj", "attr"):
                    # Check if object is an entity
                    for ent in doc.ents:
                        if child.i >= ent.start and child.i < ent.end:
                            obj = entities.get(ent.text)
                            break
            
            if subject and obj:
                relationships.append({
                    "subjectId": subject,
                    "predicate": token.lemma_,
                    "objectId": obj,
                    "confidence": 0.8  # Lower confidence for extracted relationships
                })
    
    return relationships


def build_context_graph(entities: List[Dict], relationships: List[Dict]) -> Dict[str, List[str]]:
    """
    Build an adjacency list representation of the entity relationship graph.
    
    Args:
        entities: List of entity dictionaries
        relationships: List of relationship dictionaries
        
    Returns:
        Dictionary mapping entity IDs to lists of connected entity IDs
    """
    graph: Dict[str, List[str]] = {}
    
    # Initialize all entities in graph
    for ent in entities:
        graph[ent["id"]] = []
    
    # Add relationships as edges
    for rel in relationships:
        subject_id = rel["subjectId"]
        object_id = rel["objectId"]
        
        if subject_id in graph:
            if object_id not in graph[subject_id]:
                graph[subject_id].append(object_id)
        
        # Add reverse edge for undirected graph
        if object_id in graph:
            if subject_id not in graph[object_id]:
                graph[object_id].append(subject_id)
    
    return graph


def analyze_text(text: str) -> Dict[str, Any]:
    """
    Perform full NER analysis on text.
    
    Args:
        text: Input text to analyze
        
    Returns:
        Dictionary with entities, relationships, and context_graph
    """
    entities = extract_entities(text)
    relationships = extract_relationships(text)
    context_graph = build_context_graph(entities, relationships)
    
    return {
        "entities": entities,
        "relationships": relationships,
        "context_graph": context_graph
    }
