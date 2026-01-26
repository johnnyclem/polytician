/**
 * Conversion Service
 *
 * Handles all 12 conversion operations between vector, markdown, and ThoughtForm representations.
 *
 * Conversion Matrix:
 * - thoughtForm → vector: Embed raw_text using sentence-transformers
 * - thoughtForm → md: Format entities and relationships as markdown
 * - vector → thoughtForm: Find nearest neighbors, reconstruct from their ThoughtForms
 * - vector → md: Find nearest neighbors, generate summary from their markdown/text
 * - md → vector: Embed markdown text using sentence-transformers
 * - md → thoughtForm: Parse markdown, extract entities via NER
 */

import { conceptService } from './concept.service.js';
import { pythonBridge } from './python-bridge.js';
import type { Vector, Markdown } from '../types/concept.js';
import type { ThoughtForm, ThoughtFormInput } from '../types/thoughtform.js';

export class ConversionService {
  // ============ ThoughtForm Conversions ============

  /**
   * Convert ThoughtForm to Vector
   * Embeds the raw_text using sentence-transformers
   */
  async thoughtFormToVector(id: string): Promise<Vector> {
    const tf = await conceptService.readThoughtForm(id);

    if (!tf) {
      throw new Error(`ThoughtForm not found for concept ${id}`);
    }

    // Generate embedding from raw text
    const vector = await pythonBridge.embed(tf.rawText);

    // Save the vector representation
    await conceptService.saveVector(id, vector);

    // Also cache the embedding in ThoughtForm
    tf.embeddings = vector;
    await conceptService.saveThoughtForm(id, tf);

    return vector;
  }

  /**
   * Convert ThoughtForm to Markdown
   * Formats entities, relationships, and raw text as markdown
   */
  async thoughtFormToMarkdown(id: string): Promise<Markdown> {
    const tf = await conceptService.readThoughtForm(id);

    if (!tf) {
      throw new Error(`ThoughtForm not found for concept ${id}`);
    }

    const parts: string[] = [];

    // Title (use first few words of raw text)
    const titleWords = tf.rawText.split(/\s+/).slice(0, 5).join(' ');
    parts.push(`# ${titleWords}${tf.rawText.split(/\s+/).length > 5 ? '...' : ''}\n`);

    // Metadata
    parts.push('## Metadata\n');
    parts.push(`- **Language:** ${tf.language}`);
    parts.push(`- **Created:** ${tf.metadata.timestamp}`);
    if (tf.metadata.author) {
      parts.push(`- **Author:** ${tf.metadata.author}`);
    }
    if (tf.metadata.tags.length > 0) {
      parts.push(`- **Tags:** ${tf.metadata.tags.join(', ')}`);
    }
    parts.push('');

    // Raw text
    parts.push('## Content\n');
    parts.push(tf.rawText);
    parts.push('');

    // Entities
    if (tf.entities.length > 0) {
      parts.push('## Entities\n');
      for (const entity of tf.entities) {
        parts.push(
          `- **${entity.text}** (${entity.type}, confidence: ${(entity.confidence * 100).toFixed(0)}%)`
        );
      }
      parts.push('');
    }

    // Relationships
    if (tf.relationships.length > 0) {
      parts.push('## Relationships\n');
      for (const rel of tf.relationships) {
        const subject = tf.entities.find(e => e.id === rel.subjectId);
        const object = tf.entities.find(e => e.id === rel.objectId);
        if (subject && object) {
          parts.push(`- ${subject.text} **${rel.predicate}** ${object.text}`);
        }
      }
      parts.push('');
    }

    const md = parts.join('\n');

    // Save the markdown representation
    await conceptService.saveMarkdown(id, md);

    return md;
  }

  // ============ Vector Conversions ============

  /**
   * Convert Vector to ThoughtForm
   * Finds nearest neighbors and reconstructs from their ThoughtForms
   */
  async vectorToThoughtForm(id: string): Promise<ThoughtForm> {
    const vector = await conceptService.readVector(id);

    if (!vector) {
      throw new Error(`Vector not found for concept ${id}`);
    }

    // Search for nearest neighbors
    const neighbors = await pythonBridge.searchNN(vector, 5);

    // Try to find a neighbor with ThoughtForm data
    const neighborTexts: string[] = [];

    for (const neighbor of neighbors) {
      if (neighbor.id === id) continue; // Skip self

      const neighborTf = await conceptService.readThoughtForm(neighbor.id);
      if (neighborTf) {
        neighborTexts.push(neighborTf.rawText);
      } else {
        const neighborMd = await conceptService.readMarkdown(neighbor.id);
        if (neighborMd) {
          neighborTexts.push(neighborMd);
        }
      }
    }

    // Generate a synthetic ThoughtForm based on neighbors
    let rawText: string;
    if (neighborTexts.length > 0) {
      rawText =
        `Reconstructed from ${neighborTexts.length} similar concepts:\n\n` +
        neighborTexts.map((t, i) => `${i + 1}. ${t.slice(0, 200)}`).join('\n\n');
    } else {
      rawText = `Vector representation (${vector.length} dimensions). No similar concepts found for reconstruction.`;
    }

    // Extract entities from the reconstructed text
    const nerResult = await pythonBridge.extractNER(rawText);

    const tf: ThoughtForm = {
      id,
      rawText,
      language: 'en',
      metadata: {
        timestamp: new Date().toISOString(),
        author: null,
        tags: ['reconstructed', 'from_vector'],
        source: 'converted',
      },
      entities: nerResult.entities.map((e, i) => ({
        id: `ent_${i}`,
        text: e.text,
        type: e.type,
        confidence: e.confidence,
        offset: e.offset,
      })),
      relationships: nerResult.relationships,
      contextGraph: nerResult.context_graph,
      embeddings: vector,
    };

    // Save the ThoughtForm representation
    await conceptService.saveThoughtForm(id, tf);

    return tf;
  }

  /**
   * Convert Vector to Markdown
   * Finds nearest neighbors and generates summary from their content
   */
  async vectorToMarkdown(id: string): Promise<Markdown> {
    const vector = await conceptService.readVector(id);

    if (!vector) {
      throw new Error(`Vector not found for concept ${id}`);
    }

    // Search for nearest neighbors
    const neighbors = await pythonBridge.searchNN(vector, 5);

    // Collect text from neighbors
    const neighborIds: string[] = [];
    const neighborTexts: string[] = [];

    for (const neighbor of neighbors) {
      if (neighbor.id === id) continue;

      neighborIds.push(neighbor.id);

      const md = await conceptService.readMarkdown(neighbor.id);
      if (md) {
        neighborTexts.push(md);
      } else {
        const tf = await conceptService.readThoughtForm(neighbor.id);
        if (tf) {
          neighborTexts.push(tf.rawText);
        }
      }
    }

    // Generate markdown summary
    const md = await pythonBridge.summarize(neighborIds, neighborTexts);

    // Save the markdown representation
    await conceptService.saveMarkdown(id, md);

    return md;
  }

  // ============ Markdown Conversions ============

  /**
   * Convert Markdown to Vector
   * Embeds the markdown text using sentence-transformers
   */
  async markdownToVector(id: string): Promise<Vector> {
    const md = await conceptService.readMarkdown(id);

    if (!md) {
      throw new Error(`Markdown not found for concept ${id}`);
    }

    // Generate embedding from markdown
    const vector = await pythonBridge.embed(md);

    // Save the vector representation
    await conceptService.saveVector(id, vector);

    return vector;
  }

  /**
   * Convert Markdown to ThoughtForm
   * Parses markdown and extracts entities via NER
   */
  async markdownToThoughtForm(id: string): Promise<ThoughtForm> {
    const md = await conceptService.readMarkdown(id);

    if (!md) {
      throw new Error(`Markdown not found for concept ${id}`);
    }

    // Extract entities from markdown
    const nerResult = await pythonBridge.extractNER(md);

    // Create ThoughtForm from markdown
    const tf: ThoughtForm = {
      id,
      rawText: md,
      language: 'en',
      metadata: {
        timestamp: new Date().toISOString(),
        author: null,
        tags: ['from_markdown'],
        source: 'converted',
      },
      entities: nerResult.entities.map((e, i) => ({
        id: `ent_${i}`,
        text: e.text,
        type: e.type,
        confidence: e.confidence,
        offset: e.offset,
      })),
      relationships: nerResult.relationships,
      contextGraph: nerResult.context_graph,
    };

    // Save the ThoughtForm representation
    await conceptService.saveThoughtForm(id, tf);

    return tf;
  }

  // ============ Convenience Methods ============

  /**
   * Convert between any two representations
   */
  async convert(
    id: string,
    from: 'vectors' | 'md' | 'thoughtForm',
    to: 'vectors' | 'md' | 'thoughtForm'
  ): Promise<Vector | Markdown | ThoughtForm> {
    if (from === to) {
      throw new Error(`Cannot convert ${from} to itself`);
    }

    // Map to conversion function
    const conversionKey = `${from}_to_${to}`;

    switch (conversionKey) {
      case 'thoughtForm_to_vectors':
        return this.thoughtFormToVector(id);
      case 'thoughtForm_to_md':
        return this.thoughtFormToMarkdown(id);
      case 'vectors_to_thoughtForm':
        return this.vectorToThoughtForm(id);
      case 'vectors_to_md':
        return this.vectorToMarkdown(id);
      case 'md_to_vectors':
        return this.markdownToVector(id);
      case 'md_to_thoughtForm':
        return this.markdownToThoughtForm(id);
      default:
        throw new Error(`Unknown conversion: ${from} → ${to}`);
    }
  }
}

// Singleton instance
export const conversionService = new ConversionService();
