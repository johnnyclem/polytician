/**
 * Read Commands
 *
 * Handlers for read_concept_from_vectors, read_concept_from_md, read_concept_from_thoughtForm
 */

import { z } from "zod";
import { conceptService } from "../services/concept.service.js";
import { ReadConceptInputSchema, VECTOR_DIMENSION } from "../types/concept.js";
import type { ConceptResponse, Vector, Markdown } from "../types/concept.js";
import type { ThoughtForm } from "../types/thoughtform.js";

/**
 * Read concept as vectors
 */
export async function readConceptFromVectors(
  input: unknown
): Promise<ConceptResponse<{ vector: Vector }>> {
  try {
    const parsed = ReadConceptInputSchema.parse(input);

    const vector = await conceptService.readVector(parsed.id);

    if (!vector) {
      return {
        success: false,
        error: `Vector representation not found for concept ${parsed.id}`,
      };
    }

    return {
      success: true,
      data: { vector },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Read concept as markdown
 */
export async function readConceptFromMarkdown(
  input: unknown
): Promise<ConceptResponse<{ md: Markdown }>> {
  try {
    const parsed = ReadConceptInputSchema.parse(input);

    const md = await conceptService.readMarkdown(parsed.id);

    if (!md) {
      return {
        success: false,
        error: `Markdown representation not found for concept ${parsed.id}`,
      };
    }

    return {
      success: true,
      data: { md },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Read concept as ThoughtForm
 */
export async function readConceptFromThoughtForm(
  input: unknown
): Promise<ConceptResponse<{ thoughtForm: ThoughtForm }>> {
  try {
    const parsed = ReadConceptInputSchema.parse(input);

    const thoughtForm = await conceptService.readThoughtForm(parsed.id);

    if (!thoughtForm) {
      return {
        success: false,
        error: `ThoughtForm representation not found for concept ${parsed.id}`,
      };
    }

    return {
      success: true,
      data: { thoughtForm },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Export command definitions for MCP tool registration
export const readCommands = {
  read_concept_from_vectors: {
    description: "Read the vector representation (768-dim float array) for a concept",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", description: "Concept UUID" },
      },
      required: ["id"],
    },
    handler: readConceptFromVectors,
  },
  read_concept_from_md: {
    description: "Read the markdown representation for a concept",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", description: "Concept UUID" },
      },
      required: ["id"],
    },
    handler: readConceptFromMarkdown,
  },
  read_concept_from_thoughtForm: {
    description: "Read the ThoughtForm (structured JSON) representation for a concept",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", description: "Concept UUID" },
      },
      required: ["id"],
    },
    handler: readConceptFromThoughtForm,
  },
};
