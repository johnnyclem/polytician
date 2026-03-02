import type { RepresentationType } from '../types/concept.js';
import type { ThoughtForm } from '../types/thoughtform.js';
import type { LLMProvider } from '../providers/llm.interface.js';
import { NullProvider } from '../providers/null.provider.js';
import { conceptService } from './concept.service.js';
import { embeddingService } from './embedding.service.js';

export class ConversionService {
  private llmProvider: LLMProvider = new NullProvider();

  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  getLLMProviderName(): string {
    return this.llmProvider.name;
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
      throw new Error(`Concept '${id}' has no markdown representation. Available: check with read_concept.`);
    }
    const embedding = await embeddingService.embed(concept.markdown);
    await conceptService.save({ id, embedding });
  }

  private async thoughtformToVector(id: string, concept: { thoughtform?: ThoughtForm | null }): Promise<void> {
    if (!concept.thoughtform) {
      throw new Error(`Concept '${id}' has no thoughtform representation.`);
    }
    const embedding = await embeddingService.embed(concept.thoughtform.rawText);
    await conceptService.save({ id, embedding });
  }

  private async thoughtformToMarkdown(id: string, concept: { thoughtform?: ThoughtForm | null }): Promise<void> {
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
        lines.push(`- **${entity.text}** (${entity.type}, confidence: ${entity.confidence.toFixed(2)})`);
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

  // --- LLM-dependent conversions ---

  private async markdownToThoughtform(id: string, concept: { markdown?: string | null }): Promise<void> {
    if (!concept.markdown) {
      throw new Error(`Concept '${id}' has no markdown representation.`);
    }
    const extracted = await this.llmProvider.extractEntities(concept.markdown);
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
    await conceptService.save({ id, thoughtform });
  }

  private async vectorToMarkdown(id: string, concept: { embedding?: number[] | null }): Promise<void> {
    if (!concept.embedding) {
      throw new Error(`Concept '${id}' has no vector representation.`);
    }
    const neighbors = await conceptService.search(concept.embedding, 5);
    const neighborTexts: string[] = [];
    for (const n of neighbors) {
      if (n.id === id) continue;
      const neighborConcept = await conceptService.read(n.id);
      if (neighborConcept.markdown) neighborTexts.push(neighborConcept.markdown);
      else if (neighborConcept.thoughtform) neighborTexts.push((neighborConcept.thoughtform as ThoughtForm).rawText);
    }

    const markdown = await this.llmProvider.summarize(neighborTexts.length > 0 ? neighborTexts : ['[No neighbor context available]']);
    await conceptService.save({ id, markdown });
  }

  private async vectorToThoughtform(id: string, concept: { embedding?: number[] | null }): Promise<void> {
    if (!concept.embedding) {
      throw new Error(`Concept '${id}' has no vector representation.`);
    }
    const neighbors = await conceptService.search(concept.embedding, 5);
    const neighborTexts: string[] = [];
    for (const n of neighbors) {
      if (n.id === id) continue;
      const neighborConcept = await conceptService.read(n.id);
      if (neighborConcept.markdown) neighborTexts.push(neighborConcept.markdown);
      else if (neighborConcept.thoughtform) neighborTexts.push((neighborConcept.thoughtform as ThoughtForm).rawText);
    }

    const combinedText = neighborTexts.length > 0 ? neighborTexts.join('\n\n') : '[No neighbor context available]';
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
}

export const conversionService = new ConversionService();
