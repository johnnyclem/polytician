/**
 * Save Commands
 *
 * Handlers for save_concept_as_vectors, save_concept_as_md, save_concept_as_thoughtForm
 */

import { z } from 'zod';
import { conceptService } from '../services/concept.service.js';
import {
  SaveVectorInputSchema,
  SaveMarkdownInputSchema,
  SaveThoughtFormInputSchema,
  VECTOR_DIMENSION,
} from '../types/concept.js';
import type { ConceptResponse } from '../types/concept.js';

/**
 * Save concept as vectors
 */
export async function saveConceptAsVectors(
  input: unknown
): Promise<ConceptResponse<{ id: string }>> {
  try {
    const parsed = SaveVectorInputSchema.parse(input);

    if (parsed.vector.length !== VECTOR_DIMENSION) {
      return {
        success: false,
        error: `Vector dimension mismatch: expected ${VECTOR_DIMENSION}, got ${parsed.vector.length}`,
      };
    }

    const result = await conceptService.saveVector(parsed.id, parsed.vector, parsed.tags);

    return {
      success: true,
      data: { id: result.id },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map(e => e.message).join(', ')}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Save concept as markdown
 */
export async function saveConceptAsMarkdown(
  input: unknown
): Promise<ConceptResponse<{ id: string }>> {
  try {
    const parsed = SaveMarkdownInputSchema.parse(input);

    const result = await conceptService.saveMarkdown(parsed.id, parsed.md, parsed.tags);

    return {
      success: true,
      data: { id: result.id },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map(e => e.message).join(', ')}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Save concept as ThoughtForm
 */
export async function saveConceptAsThoughtForm(
  input: unknown
): Promise<ConceptResponse<{ id: string }>> {
  try {
    const parsed = SaveThoughtFormInputSchema.parse(input);

    const result = await conceptService.saveThoughtForm(parsed.id, parsed.thoughtForm, parsed.tags);

    return {
      success: true,
      data: { id: result.id },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map(e => e.message).join(', ')}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Export command definitions for MCP tool registration
export const saveCommands = {
  save_concept_as_vectors: {
    description: 'Save a vector representation (768-dim float array) for a concept',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'Concept UUID' },
        vector: {
          type: 'array',
          items: { type: 'number' },
          minItems: VECTOR_DIMENSION,
          maxItems: VECTOR_DIMENSION,
          description: `${VECTOR_DIMENSION}-dimensional embedding vector`,
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for the concept',
        },
      },
      required: ['id', 'vector'],
    },
    handler: saveConceptAsVectors,
  },
  save_concept_as_md: {
    description: 'Save a markdown representation for a concept',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'Concept UUID' },
        md: { type: 'string', minLength: 1, description: 'Markdown content' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for the concept',
        },
      },
      required: ['id', 'md'],
    },
    handler: saveConceptAsMarkdown,
  },
  save_concept_as_thoughtForm: {
    description: 'Save a ThoughtForm (structured JSON) representation for a concept',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'Concept UUID' },
        thoughtForm: {
          type: 'object',
          properties: {
            rawText: { type: 'string', description: 'Raw text content' },
            language: { type: 'string', default: 'en', description: 'ISO-639-1 language code' },
            metadata: {
              type: 'object',
              properties: {
                timestamp: { type: 'string', format: 'date-time' },
                author: { type: 'string', nullable: true },
                tags: { type: 'array', items: { type: 'string' } },
                source: { type: 'string' },
              },
            },
            entities: { type: 'array', description: 'Extracted named entities' },
            relationships: { type: 'array', description: 'Entity relationships' },
            contextGraph: { type: 'object', description: 'Adjacency list of entity connections' },
            embeddings: { type: 'array', items: { type: 'number' }, description: 'Cached vector' },
          },
          required: ['rawText'],
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for the concept',
        },
      },
      required: ['id', 'thoughtForm'],
    },
    handler: saveConceptAsThoughtForm,
  },
};
