/**
 * Concept Service
 *
 * CRUD operations for concepts with vector, markdown, and ThoughtForm representations.
 */

import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client.js";
import { concepts, type ConceptRow } from "../db/schema.js";
import { VECTOR_DIMENSION, type Vector, type Markdown } from "../types/concept.js";
import type { ThoughtForm, ThoughtFormInput } from "../types/thoughtform.js";
import { pythonBridge } from "./python-bridge.js";

/**
 * Serialize a vector to a Buffer for storage
 */
function vectorToBuffer(vector: Vector): Buffer {
  const float32Array = new Float32Array(vector);
  return Buffer.from(float32Array.buffer);
}

/**
 * Deserialize a Buffer to a vector
 */
function bufferToVector(buffer: Buffer): Vector {
  const float32Array = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / 4
  );
  return Array.from(float32Array);
}

/**
 * Serialize ThoughtForm to JSON string
 */
function thoughtFormToJson(tf: ThoughtForm | ThoughtFormInput): string {
  return JSON.stringify(tf);
}

/**
 * Deserialize JSON string to ThoughtForm
 */
function jsonToThoughtForm(json: string): ThoughtForm {
  return JSON.parse(json) as ThoughtForm;
}

export class ConceptService {
  /**
   * Save vector representation for a concept
   */
  async saveVector(
    id: string,
    vector: Vector,
    tags?: string[]
  ): Promise<{ success: boolean; id: string }> {
    if (vector.length !== VECTOR_DIMENSION) {
      throw new Error(
        `Vector dimension mismatch: expected ${VECTOR_DIMENSION}, got ${vector.length}`
      );
    }

    const now = new Date();
    const vectorBlob = vectorToBuffer(vector);

    // Check if concept exists
    const existing = await this.getById(id);

    if (existing) {
      // Update existing
      await db
        .update(concepts)
        .set({
          updatedAt: now,
          vectorBlob,
          tags: tags ?? existing.tags,
        })
        .where(eq(concepts.id, id));
    } else {
      // Insert new
      await db.insert(concepts).values({
        id,
        createdAt: now,
        updatedAt: now,
        vectorBlob,
        tags: tags ?? [],
      });
    }

    // Update FAISS index
    await pythonBridge.addToIndex(id, vector);

    return { success: true, id };
  }

  /**
   * Save markdown representation for a concept
   */
  async saveMarkdown(
    id: string,
    md: Markdown,
    tags?: string[]
  ): Promise<{ success: boolean; id: string }> {
    const now = new Date();
    const existing = await this.getById(id);

    if (existing) {
      await db
        .update(concepts)
        .set({
          updatedAt: now,
          mdBlob: md,
          tags: tags ?? existing.tags,
        })
        .where(eq(concepts.id, id));
    } else {
      await db.insert(concepts).values({
        id,
        createdAt: now,
        updatedAt: now,
        mdBlob: md,
        tags: tags ?? [],
      });
    }

    return { success: true, id };
  }

  /**
   * Save ThoughtForm representation for a concept
   */
  async saveThoughtForm(
    id: string,
    thoughtForm: ThoughtFormInput,
    tags?: string[]
  ): Promise<{ success: boolean; id: string }> {
    const now = new Date();
    const existing = await this.getById(id);

    // Ensure ThoughtForm has an ID
    const tfWithId: ThoughtForm = {
      id,
      rawText: thoughtForm.rawText,
      language: thoughtForm.language ?? "en",
      metadata: {
        timestamp: thoughtForm.metadata?.timestamp ?? now.toISOString(),
        author: thoughtForm.metadata?.author ?? null,
        tags: thoughtForm.metadata?.tags ?? tags ?? [],
        source: thoughtForm.metadata?.source ?? "user_input",
      },
      entities: thoughtForm.entities ?? [],
      relationships: thoughtForm.relationships ?? [],
      contextGraph: thoughtForm.contextGraph ?? {},
      embeddings: thoughtForm.embeddings,
    };

    const tfJson = thoughtFormToJson(tfWithId);

    if (existing) {
      await db
        .update(concepts)
        .set({
          updatedAt: now,
          thoughtformBlob: tfJson,
          tags: tags ?? existing.tags,
        })
        .where(eq(concepts.id, id));
    } else {
      await db.insert(concepts).values({
        id,
        createdAt: now,
        updatedAt: now,
        thoughtformBlob: tfJson,
        tags: tags ?? [],
      });
    }

    return { success: true, id };
  }

  /**
   * Read vector representation for a concept
   */
  async readVector(id: string): Promise<Vector | null> {
    const row = await this.getById(id);

    if (!row?.vectorBlob) {
      return null;
    }

    return bufferToVector(row.vectorBlob);
  }

  /**
   * Read markdown representation for a concept
   */
  async readMarkdown(id: string): Promise<Markdown | null> {
    const row = await this.getById(id);
    return row?.mdBlob ?? null;
  }

  /**
   * Read ThoughtForm representation for a concept
   */
  async readThoughtForm(id: string): Promise<ThoughtForm | null> {
    const row = await this.getById(id);

    if (!row?.thoughtformBlob) {
      return null;
    }

    return jsonToThoughtForm(row.thoughtformBlob);
  }

  /**
   * Get a concept row by ID
   */
  async getById(id: string): Promise<ConceptRow | null> {
    const rows = await db
      .select()
      .from(concepts)
      .where(eq(concepts.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * List all concepts
   */
  async listAll(): Promise<ConceptRow[]> {
    return db.select().from(concepts);
  }

  /**
   * Delete a concept
   */
  async delete(id: string): Promise<boolean> {
    const result = await db.delete(concepts).where(eq(concepts.id, id));

    // Also remove from FAISS index
    await pythonBridge.removeFromIndex(id);

    return true;
  }

  /**
   * Check which representations exist for a concept
   */
  async getRepresentations(
    id: string
  ): Promise<{ vectors: boolean; md: boolean; thoughtForm: boolean }> {
    const row = await this.getById(id);

    if (!row) {
      return { vectors: false, md: false, thoughtForm: false };
    }

    return {
      vectors: row.vectorBlob !== null,
      md: row.mdBlob !== null,
      thoughtForm: row.thoughtformBlob !== null,
    };
  }

  /**
   * Generate a new concept ID
   */
  generateId(): string {
    return uuidv4();
  }
}

// Singleton instance
export const conceptService = new ConceptService();
