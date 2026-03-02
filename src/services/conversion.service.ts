import type { RepresentationType } from '../types/concept.js';
import type { ThoughtForm } from '../types/thoughtform.js';
import { ThoughtFormSchema } from '../types/thoughtform.js';
import type { LLMProvider, ThoughtFormEntities } from '../providers/llm.interface.js';
import type { NLPPipeline, NLPPipelineOptions } from '../providers/nlp-pipeline.interface.js';
import { NullProvider } from '../providers/null.provider.js';
import { conceptService } from './concept.service.js';
import { embeddingService } from './embedding.service.js';

export class ConversionService {
  private llmProvider: LLMProvider = new NullProvider();
  private nlpPipeline: NLPPipeline | null = null;

  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  getLLMProviderName(): string {
    return this.llmProvider.name;
  }

  setNLPPipeline(pipeline: NLPPipeline): void {
    this.nlpPipeline = pipeline;
  }

  getNLPPipelineName(): string | null {
    return this.nlpPipeline?.name ?? null;
  }

  async convert(id: string, from: RepresentationType, to: RepresentationType): Promise<void> {
    if (from === to) throw new Error(`Cannot convert from '${from}' to itself`);

    const concept = await conceptService.read(id);

    const key = `${from}->${to}`;
    switch (key) {
      case 'markdown->vector':
        await this.markdownToVector(id, concept);
        break;
      case 'thoughtform->vector':
        await this.thoughtformToVector(id, concept);
        break;
      case 'thoughtform->markdown':
        await this.thoughtformToMarkdown(id, concept);
        break;
      case 'markdown->thoughtform':
        await this.markdownToThoughtform(id, concept);
        break;
      case 'vector->markdown':
        await this.vectorToMarkdown(id, concept);
        break;
      case 'vector->thoughtform':
        await this.vectorToThoughtform(id, concept);
        break;
      default:
        throw new Error(`Unsupported conversion: ${from} -> ${to}`);
    }
  }

  // --- Non-LLM conversions ---

  private async markdownToVector(id: string, concept: { markdown?: string | null }): Promise<void> {
    if (!concept.markdown) {
      throw new Error(
        `Concept '${id}' has no markdown representation. Available: check with read_concept.`
      );
    }
    const embedding = await embeddingService.embed(concept.markdown);
    await conceptService.save({ id, embedding });
  }

  private async thoughtformToVector(
    id: string,
    concept: { thoughtform?: ThoughtForm | null }
  ): Promise<void> {
    if (!concept.thoughtform) {
      throw new Error(`Concept '${id}' has no thoughtform representation.`);
    }
    const embedding = await embeddingService.embed(concept.thoughtform.rawText);
    await conceptService.save({ id, embedding });
  }

  private async thoughtformToMarkdown(
    id: string,
    concept: { thoughtform?: ThoughtForm | null }
  ): Promise<void> {
    if (!concept.thoughtform) {
      throw new Error(`Concept '${id}' has no thoughtform representation.`);
    }

    const tf = concept.thoughtform;
    const lines: string[] = [];

    lines.push(`# ${tf.rawText.slice(0, 80)}`);
    lines.push('');
    lines.push(tf.rawText);

    if (tf.entities.length > 0) {
      lines.push('');
      lines.push('## Entities');
      lines.push('');
      for (const entity of tf.entities) {
        lines.push(
          `- **${entity.text}** (${entity.type}, confidence: ${entity.confidence.toFixed(2)})`
        );
      }
    }

    if (tf.relationships.length > 0) {
      lines.push('');
      lines.push('## Relationships');
      lines.push('');
      for (const rel of tf.relationships) {
        const subject = tf.entities.find(e => e.id === rel.subjectId)?.text ?? rel.subjectId;
        const object = tf.entities.find(e => e.id === rel.objectId)?.text ?? rel.objectId;
        lines.push(`- ${subject} **${rel.predicate}** ${object}`);
      }
    }

    const markdown = lines.join('\n');
    await conceptService.save({ id, markdown });
  }

  // --- LLM / NLP pipeline conversions ---

  /**
   * Convert markdown to ThoughtForm using either a configured NLP pipeline
   * or the LLM provider. Results are validated against the ThoughtForm schema.
   */
  private async markdownToThoughtform(
    id: string,
    concept: { markdown?: string | null }
  ): Promise<void> {
    if (!concept.markdown) {
      throw new Error(`Concept '${id}' has no markdown representation.`);
    }

    let extracted: ThoughtFormEntities;

    if (this.nlpPipeline) {
      // Use configurable NLP pipeline with dependency parsing enabled
      const pipelineOptions: NLPPipelineOptions = {
        inferRelationships: true,
      };
      extracted = await this.nlpPipeline.extractEntities(concept.markdown, pipelineOptions);
    } else {
      // Fall back to LLM-based entity extraction
      extracted = await this.llmProvider.extractEntities(concept.markdown);
    }

    const now = new Date().toISOString();
    const thoughtform: ThoughtForm = {
      id,
      rawText: concept.markdown,
      language: 'en',
      metadata: {
        createdAt: now,
        updatedAt: now,
        author: null,
        tags: [],
        source: 'converted',
      },
      entities: extracted.entities,
      relationships: extracted.relationships,
      contextGraph: extracted.contextGraph,
    };

    // Validate against schema before saving
    this.validateThoughtForm(thoughtform);

    await conceptService.save({ id, thoughtform });
  }

  /**
   * Convert vector to markdown. When an LLM is configured, uses the LLM
   * summarizer with nearest-neighbor context in the prompt. Without an LLM,
   * reconstructs markdown directly from neighbor content.
   */
  private async vectorToMarkdown(
    id: string,
    concept: { embedding?: number[] | null }
  ): Promise<void> {
    if (!concept.embedding) {
      throw new Error(`Concept '${id}' has no vector representation.`);
    }

    const neighbors = await conceptService.search(concept.embedding, 5);
    const neighborData: Array<{ text: string; distance: number }> = [];
    for (const n of neighbors) {
      if (n.id === id) continue;
      const neighborConcept = await conceptService.read(n.id);
      const text =
        neighborConcept.markdown ??
        (neighborConcept.thoughtform ? (neighborConcept.thoughtform as ThoughtForm).rawText : null);
      if (text) {
        neighborData.push({ text, distance: n.distance });
      }
    }

    let markdown: string;

    if (this.llmProvider.name !== 'none') {
      // LLM path: include nearest-neighbor context in the prompt
      const texts =
        neighborData.length > 0
          ? neighborData.map(n => n.text)
          : ['[No neighbor context available]'];
      markdown = await this.llmProvider.summarize(texts, {
        neighborDistances: neighborData.map(n => n.distance),
        conceptId: id,
      });
    } else {
      // Non-LLM fallback: reconstruct from neighbor context
      markdown = this.reconstructFromNeighbors(neighborData);
    }

    await conceptService.save({ id, markdown });
  }

  private async vectorToThoughtform(
    id: string,
    concept: { embedding?: number[] | null }
  ): Promise<void> {
    if (!concept.embedding) {
      throw new Error(`Concept '${id}' has no vector representation.`);
    }
    const neighbors = await conceptService.search(concept.embedding, 5);
    const neighborTexts: string[] = [];
    for (const n of neighbors) {
      if (n.id === id) continue;
      const neighborConcept = await conceptService.read(n.id);
      if (neighborConcept.markdown) neighborTexts.push(neighborConcept.markdown);
      else if (neighborConcept.thoughtform)
        neighborTexts.push((neighborConcept.thoughtform as ThoughtForm).rawText);
    }

    const combinedText =
      neighborTexts.length > 0 ? neighborTexts.join('\n\n') : '[No neighbor context available]';
    const extracted = await this.llmProvider.extractEntities(combinedText);
    const now = new Date().toISOString();
    const thoughtform: ThoughtForm = {
      id,
      rawText: combinedText,
      language: 'en',
      metadata: {
        createdAt: now,
        updatedAt: now,
        author: null,
        tags: [],
        source: 'converted',
      },
      entities: extracted.entities,
      relationships: extracted.relationships,
      contextGraph: extracted.contextGraph,
    };
    await conceptService.save({ id, thoughtform });
  }

  /**
   * Reconstruct markdown from nearest-neighbor texts without an LLM.
   * Produces a coherent document by combining and attributing neighbor content.
   */
  private reconstructFromNeighbors(neighbors: Array<{ text: string; distance: number }>): string {
    if (neighbors.length === 0) {
      return '# Reconstructed Concept\n\nNo neighboring concepts available for reconstruction.';
    }

    const lines: string[] = [];
    lines.push('# Reconstructed Concept');
    lines.push('');
    lines.push('*Reconstructed from nearest-neighbor context.*');
    lines.push('');

    // Sort by distance (closest first)
    const sorted = [...neighbors].sort((a, b) => a.distance - b.distance);

    if (sorted.length === 1) {
      const first = sorted[0];
      if (first) lines.push(first.text);
    } else {
      for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i];
        if (!n) continue;
        lines.push(`## Related Context ${i + 1}`);
        lines.push('');
        lines.push(n.text);
        if (i < sorted.length - 1) lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Validate ThoughtForm output against the Zod schema.
   * Throws a descriptive error if validation fails.
   */
  private validateThoughtForm(thoughtform: ThoughtForm): void {
    const result = ThoughtFormSchema.safeParse(thoughtform);
    if (!result.success) {
      const issues = result.error.issues
        .map(
          (issue: { path: (string | number)[]; message: string }) =>
            `${issue.path.join('.')}: ${issue.message}`
        )
        .join('; ');
      throw new Error(`ThoughtForm validation failed: ${issues}`);
    }
  }
}

export const conversionService = new ConversionService();
