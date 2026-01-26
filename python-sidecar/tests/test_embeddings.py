"""
Unit tests for embeddings service
"""

import pytest
import numpy as np
from unittest.mock import patch, MagicMock

# Import the module to test
import embeddings


class TestEmbeddings:
    """Test suite for the embeddings service"""

    @patch('embeddings.SentenceTransformer')
    def test_get_model_initializes_once(self, mock_transformer):
        """Test that the model is initialized only once"""
        # Reset the global model variable
        embeddings._model = None
        
        # First call should initialize the model
        model1 = embeddings.get_model()
        mock_transformer.assert_called_once_with(embeddings.MODEL_NAME)
        
        # Reset the mock for next call
        mock_transformer.reset_mock()
        
        # Second call should not initialize again
        model2 = embeddings.get_model()
        mock_transformer.assert_not_called()
        
        assert model1 is model2

    @patch('embeddings.get_model')
    def test_embed_text(self, mock_get_model):
        """Test embedding a single text"""
        # Mock the model
        mock_model = MagicMock()
        mock_model.encode.return_value = np.array([0.1, 0.2, 0.3, 0.4, 0.5])
        mock_get_model.return_value = mock_model
        
        # Test the function
        result = embeddings.embed_text("test text")
        
        # Verify the model was called correctly
        mock_model.encode.assert_called_once_with("test text", convert_to_numpy=True)
        
        # Verify the result
        expected = [0.1, 0.2, 0.3, 0.4, 0.5]
        assert result == expected

    @patch('embeddings.get_model')
    def test_embed_texts(self, mock_get_model):
        """Test embedding multiple texts"""
        # Mock the model
        mock_model = MagicMock()
        mock_embeddings = np.array([
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
            [0.7, 0.8, 0.9]
        ])
        mock_model.encode.return_value = mock_embeddings
        mock_get_model.return_value = mock_model
        
        # Test the function
        texts = ["text1", "text2", "text3"]
        result = embeddings.embed_texts(texts)
        
        # Verify the model was called correctly
        mock_model.encode.assert_called_once_with(texts, convert_to_numpy=True)
        
        # Verify the result
        expected = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]]
        assert result == expected

    def test_cosine_similarity_identical_vectors(self):
        """Test cosine similarity with identical vectors"""
        vec1 = [1.0, 2.0, 3.0]
        vec2 = [1.0, 2.0, 3.0]
        
        result = embeddings.cosine_similarity(vec1, vec2)
        
        # Identical vectors should have similarity of 1.0
        assert abs(result - 1.0) < 1e-10

    def test_cosine_similarity_orthogonal_vectors(self):
        """Test cosine similarity with orthogonal vectors"""
        vec1 = [1.0, 0.0]
        vec2 = [0.0, 1.0]
        
        result = embeddings.cosine_similarity(vec1, vec2)
        
        # Orthogonal vectors should have similarity of 0.0
        assert abs(result - 0.0) < 1e-10

    def test_cosine_similarity_opposite_vectors(self):
        """Test cosine similarity with opposite vectors"""
        vec1 = [1.0, 2.0, 3.0]
        vec2 = [-1.0, -2.0, -3.0]
        
        result = embeddings.cosine_similarity(vec1, vec2)
        
        # Opposite vectors should have similarity of -1.0
        assert abs(result + 1.0) < 1e-10

    def test_cosine_similarity_zero_vectors(self):
        """Test cosine similarity with zero vectors"""
        vec1 = [0.0, 0.0, 0.0]
        vec2 = [1.0, 2.0, 3.0]
        
        result = embeddings.cosine_similarity(vec1, vec2)
        
        # Should handle zero vectors gracefully (should be 0.0)
        assert result == 0.0

    def test_vector_dimension_constants(self):
        """Test that dimension constants are properly set"""
        assert embeddings.VECTOR_DIMENSION == 768
        assert embeddings.MODEL_NAME == "all-MiniLM-L6-v2"

    @patch('embeddings.get_model')
    def test_embed_text_handles_empty_string(self, mock_get_model):
        """Test embedding an empty string"""
        mock_model = MagicMock()
        mock_model.encode.return_value = np.array([0.0] * 768)
        mock_get_model.return_value = mock_model
        
        result = embeddings.embed_text("")
        
        mock_model.encode.assert_called_once_with("", convert_to_numpy=True)
        assert result == [0.0] * 768

    @patch('embeddings.get_model')
    def test_embed_texts_handles_empty_list(self, mock_get_model):
        """Test embedding an empty list of texts"""
        mock_model = MagicMock()
        mock_model.encode.return_value = np.array([]).reshape(0, 768)
        mock_get_model.return_value = mock_model
        
        result = embeddings.embed_texts([])
        
        mock_model.encode.assert_called_once_with([], convert_to_numpy=True)
        assert result == []