/**
 * Convert Commands
 *
 * Handlers for all 6 conversion operations between vector, markdown, and ThoughtForm
 */

import { z } from "zod";
import { conversionService } from "../services/conversion.service.js";
import { ConvertConceptInputSchema, VECTOR_DIMENSION } from "../types/concept.js";
import type { ConceptResponse, Vector, Markdown } from "../types/concept.js";
import type { ThoughtForm } from "../types/thoughtform.js";

/**
 * Convert ThoughtForm to Vector
 */
export async function convertThoughtFormToVectors(
  input: unknown
): Promise<ConceptResponse<{ vector: Vector }>> {
  try {
    const parsed = ConvertConceptInputSchema.parse(input);
    const vector = await conversionService.thoughtFormToVector(parsed.id);

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
 * Convert ThoughtForm to Markdown
 */
export async function convertThoughtFormToMarkdown(
  input: unknown
): Promise<ConceptResponse<{ md: Markdown }>> {
  try {
    const parsed = ConvertConceptInputSchema.parse(input);
    const md = await conversionService.thoughtFormToMarkdown(parsed.id);

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
 * Convert Vector to ThoughtForm
 */
export async function convertVectorsToThoughtForm(
  input: unknown
): Promise<ConceptResponse<{ thoughtForm: ThoughtForm }>> {
  try {
    const parsed = ConvertConceptInputSchema.parse(input);
    const thoughtForm = await conversionService.vectorToThoughtForm(parsed.id);

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

/**
 * Convert Vector to Markdown
 */
export async function convertVectorsToMarkdown(
  input: unknown
): Promise<ConceptResponse<{ md: Markdown }>> {
  try {
    const parsed = ConvertConceptInputSchema.parse(input);
    const md = await conversionService.vectorToMarkdown(parsed.id);

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
 * Convert Markdown to Vector
 */
export async function convertMarkdownToVectors(
  input: unknown
): Promise<ConceptResponse<{ vector: Vector }>> {
  try {
    const parsed = ConvertConceptInputSchema.parse(input);
    const vector = await conversionService.markdownToVector(parsed.id);

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
 * Convert Markdown to ThoughtForm
 */
export async function convertMarkdownToThoughtForm(
  input: unknown
): Promise<ConceptResponse<{ thoughtForm: ThoughtForm }>> {
  try {
    const parsed = ConvertConceptInputSchema.parse(input);
    const thoughtForm = await conversionService.markdownToThoughtForm(parsed.id);

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

// Common input schema for all convert commands
const convertInputSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid", description: "Concept UUID" },
  },
  required: ["id"],
};

// Export command definitions for MCP tool registration
export const convertCommands = {
  convert_concept_from_thoughtForm_to_vectors: {
    description: "Convert ThoughtForm to vector representation by embedding the raw text",
    inputSchema: convertInputSchema,
    handler: convertThoughtFormToVectors,
  },
  convert_concept_from_thoughtForm_to_md: {
    description: "Convert ThoughtForm to markdown by formatting entities and relationships",
    inputSchema: convertInputSchema,
    handler: convertThoughtFormToMarkdown,
  },
  convert_concept_from_vectors_to_thoughtForm: {
    description: "Convert vector to ThoughtForm by finding similar concepts and reconstructing",
    inputSchema: convertInputSchema,
    handler: convertVectorsToThoughtForm,
  },
  convert_concept_from_vectors_to_md: {
    description: "Convert vector to markdown by finding similar concepts and summarizing",
    inputSchema: convertInputSchema,
    handler: convertVectorsToMarkdown,
  },
  convert_concept_from_md_to_vectors: {
    description: "Convert markdown to vector representation by embedding the text",
    inputSchema: convertInputSchema,
    handler: convertMarkdownToVectors,
  },
  convert_concept_from_md_to_thoughtForm: {
    description: "Convert markdown to ThoughtForm by extracting entities via NER",
    inputSchema: convertInputSchema,
    handler: convertMarkdownToThoughtForm,
  },
};
