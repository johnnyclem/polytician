import {
  isMachineMade,
  type Concept,
  type Provenance,
  type RepresentationType,
} from '../types/concept.js';
import type { ThoughtForm } from '../types/thoughtform.js';
import {
  StoredThoughtFormSchema,
  ThoughtFormSchema,
  thoughtFormText,
  viewThoughtForm,
  type StoredThoughtForm,
  type ThoughtFormView,
} from '../types/thoughtform.js';
import type { LLMProvider, ThoughtFormEntities } from '../providers/llm.interface.js';
import type { NLPPipeline, NLPPipelineOptions } from '../providers/nlp-pipeline.interface.js';
import { NullProvider } from '../providers/null.provider.js';
import { ConversionError, OverwriteRefusedError } from '../errors/index.js';
import { conceptService, type SaveParams } from './concept.service.js';
import { embeddingService } from './embedding.service.js';
import { getConfig } from '../config.js';

/** Nearest neighbours given to the LLM as context for vector → markdown/thoughtform. */
const NEIGHBOR_COUNT = 5;

type ReadConcept = Partial<Concept> & { id: string };

export interface ConvertOptions {
  /** If set, the concept must live in this namespace (otherwise NOT_FOUND). */
  namespace?: string;
  /** Allow the derived result to replace an authored representation. */
  overwrite?: boolean;
}

function hasRepresentation(concept: ReadConcept, rep: RepresentationType): boolean {
  if (rep === 'vector') return concept.embedding !== undefined;
  if (rep === 'markdown') return concept.markdown !== undefined;
  return concept.thoughtform !== undefined;
}

/** A converted representation, ready to save with its provenance. */
type Derivation =
  | { to: 'vector'; value: number[]; provenance: Provenance }
  | { to: 'markdown'; value: string; provenance: Provenance }
  | { to: 'thoughtform'; value: ThoughtForm; provenance: Provenance };

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

  /**
   * Derive `to` from `from` and save it as a derived representation.
   *
   * The result is written with the version the source was read at, so a
   * concurrent edit of the source surfaces as VERSION_CONFLICT rather than a
   * stale derivation. It never replaces an authored representation unless
   * `overwrite` is set; replacing an earlier derived one is allowed.
   */
  async convert(
    id: string,
    from: RepresentationType,
    to: RepresentationType,
    options: ConvertOptions = {}
  ): Promise<void> {
    if (from === to) throw new ConversionError(`Cannot convert from '${from}' to itself`);

    const concept = await conceptService.read(id, undefined, { namespace: options.namespace });

    if (!hasRepresentation(concept, from)) {
      throw new ConversionError(
        `Concept '${id}' has no ${from} representation. Available: check with read_concept.`
      );
    }
    // Checked again atomically on save; failing early avoids a wasted LLM call.
    if (
      hasRepresentation(concept, to) &&
      !isMachineMade(concept.provenance?.[to]) &&
      !options.overwrite
    ) {
      throw new OverwriteRefusedError(id, to);
    }

    const derivation = await this.derive(concept, from, to);

    const save: SaveParams = {
      id,
      namespace: concept.namespace,
      expectedVersion: concept.version,
      provenance: { [derivation.to]: derivation.provenance },
      overwrite: options.overwrite,
    };
    if (derivation.to === 'vector') save.embedding = derivation.value;
    else if (derivation.to === 'markdown') save.markdown = derivation.value;
    else save.thoughtform = derivation.value;
    await conceptService.save(save);
  }

  private async derive(
    concept: ReadConcept,
    from: RepresentationType,
    to: RepresentationType
  ): Promise<Derivation> {
    switch (`${from}->${to}`) {
      case 'markdown->vector':
        return this.markdownToVector(concept);
      case 'thoughtform->vector':
        return this.thoughtformToVector(concept);
      case 'thoughtform->markdown':
        return this.thoughtformToMarkdown(concept);
      case 'markdown->thoughtform':
        return this.markdownToThoughtform(concept);
      case 'vector->markdown':
        return this.vectorToMarkdown(concept);
      case 'vector->thoughtform':
        return this.vectorToThoughtform(concept);
      default:
        throw new ConversionError(`Unsupported conversion: ${from} -> ${to}`);
    }
  }

  // --- Non-LLM conversions ---

  private async markdownToVector(concept: ReadConcept): Promise<Derivation> {
    const markdown = this.requireMarkdown(concept);
    const value = await embeddingService.embed(markdown);
    return {
      to: 'vector',
      value,
      provenance: {
        origin: 'derived',
        derivedFrom: 'markdown',
        model: embeddingService.getModel(),
      },
    };
  }

  private async thoughtformToVector(concept: ReadConcept): Promise<Derivation> {
    const tf = this.requireThoughtForm(concept);
    const text = thoughtFormText(tf);
    if (!text)
      throw new ConversionError(`Concept '${concept.id}' thoughtform has no text to embed.`);
    const value = await embeddingService.embed(text);
    return {
      to: 'vector',
      value,
      provenance: {
        origin: 'derived',
        derivedFrom: 'thoughtform',
        model: embeddingService.getModel(),
      },
    };
  }

  private async thoughtformToMarkdown(concept: ReadConcept): Promise<Derivation> {
    const tf: ThoughtFormView = viewThoughtForm(this.requireThoughtForm(concept));
    const lines: string[] = [];

    const title = tf.rawText ?? tf.entities.map(e => e.text).join(', ');
    lines.push(`# ${title.slice(0, 80)}`);
    if (tf.rawText) {
      lines.push('');
      lines.push(tf.rawText);
    }

    if (tf.entities.length > 0) {
      lines.push('');
      lines.push('## Entities');
      lines.push('');
      for (const entity of tf.entities) {
        const confidence =
          entity.confidence !== undefined ? `, confidence: ${entity.confidence.toFixed(2)}` : '';
        lines.push(`- **${entity.text}** (${entity.type}${confidence})`);
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

    return {
      to: 'markdown',
      value: lines.join('\n'),
      provenance: { origin: 'derived', derivedFrom: 'thoughtform' },
    };
  }

  // --- LLM / NLP pipeline conversions ---

  /**
   * Convert markdown to ThoughtForm using either a configured NLP pipeline
   * or the LLM provider. Results are validated against the ThoughtForm schema.
   */
  private async markdownToThoughtform(concept: ReadConcept): Promise<Derivation> {
    const markdown = this.requireMarkdown(concept);

    let extracted: ThoughtFormEntities;
    let provenance: Provenance;

    if (this.nlpPipeline) {
      // Use configurable NLP pipeline with dependency parsing enabled
      const { nlp } = getConfig();
      const pipelineOptions: NLPPipelineOptions = {
        inferRelationships: true,
        entityTypes: nlp.entityTypes,
        minConfidence: nlp.minConfidence,
      };
      extracted = await this.nlpPipeline.extractEntities(markdown, pipelineOptions);
      provenance = { origin: 'derived', derivedFrom: 'markdown', model: this.nlpPipeline.name };
    } else {
      // Fall back to LLM-based entity extraction
      this.requireLLM('markdown -> thoughtform (without POLYTICIAN_NLP_PIPELINE=rule-based)');
      extracted = await this.llmProvider.extractEntities(markdown);
      provenance = { origin: 'llm', derivedFrom: 'markdown', model: this.llmProvider.name };
    }

    const thoughtform = this.buildThoughtForm(concept.id, markdown, extracted);
    return { to: 'thoughtform', value: thoughtform, provenance };
  }

  /**
   * Convert vector to markdown by asking the LLM to summarize the concept's
   * nearest neighbours in its own namespace. There is no non-LLM path: a
   * vector cannot be decoded back to text, and splicing neighbours' text in
   * as this concept's markdown would present other concepts' content as its own.
   */
  private async vectorToMarkdown(concept: ReadConcept): Promise<Derivation> {
    this.requireLLM('vector -> markdown');
    const neighbors = await this.neighborTexts(concept);
    const texts =
      neighbors.length > 0 ? neighbors.map(n => n.text) : ['[No neighbor context available]'];
    const markdown = await this.llmProvider.summarize(texts, {
      neighborScores: neighbors.map(n => n.score),
      conceptId: concept.id,
    });
    return {
      to: 'markdown',
      value: markdown,
      provenance: {
        origin: 'llm',
        derivedFrom: 'vector',
        model: this.llmProvider.name,
        sources: neighbors.map(n => n.id),
      },
    };
  }

  private async vectorToThoughtform(concept: ReadConcept): Promise<Derivation> {
    this.requireLLM('vector -> thoughtform');
    const neighbors = await this.neighborTexts(concept);
    const combinedText =
      neighbors.length > 0
        ? neighbors.map(n => n.text).join('\n\n')
        : '[No neighbor context available]';
    const extracted = await this.llmProvider.extractEntities(combinedText);
    const thoughtform = this.buildThoughtForm(concept.id, combinedText, extracted);
    return {
      to: 'thoughtform',
      value: thoughtform,
      provenance: {
        origin: 'llm',
        derivedFrom: 'vector',
        model: this.llmProvider.name,
        sources: neighbors.map(n => n.id),
      },
    };
  }

  /** Text of the concept's nearest neighbours, searched only within its own namespace. */
  private async neighborTexts(
    concept: ReadConcept
  ): Promise<Array<{ id: string; text: string; score: number }>> {
    const embedding = concept.embedding;
    if (!embedding) {
      throw new ConversionError(`Concept '${concept.id}' has no vector representation.`);
    }
    const namespace = concept.namespace ?? 'default';
    const neighbors = await conceptService.search(embedding, NEIGHBOR_COUNT + 1, undefined, {
      namespace,
    });
    const result: Array<{ id: string; text: string; score: number }> = [];
    for (const n of neighbors) {
      if (n.id === concept.id || result.length >= NEIGHBOR_COUNT) continue;
      const neighbor = await conceptService.read(n.id, undefined, { namespace });
      const tf = neighbor.thoughtform
        ? StoredThoughtFormSchema.safeParse(neighbor.thoughtform)
        : null;
      const text = neighbor.markdown ?? (tf?.success ? thoughtFormText(tf.data) : null);
      if (text) result.push({ id: n.id, text, score: n.score });
    }
    return result;
  }

  private buildThoughtForm(
    id: string,
    rawText: string,
    extracted: ThoughtFormEntities
  ): ThoughtForm {
    const now = new Date().toISOString();
    const thoughtform: ThoughtForm = {
      id,
      rawText,
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
    this.validateThoughtForm(thoughtform);
    return thoughtform;
  }

  private requireLLM(conversion: string): void {
    if (this.llmProvider.name === 'none') {
      throw new ConversionError(
        `${conversion} requires an LLM provider; set POLYTICIAN_LLM_PROVIDER (none is configured)`
      );
    }
  }

  private requireMarkdown(concept: ReadConcept): string {
    if (concept.markdown === undefined || concept.markdown === null) {
      throw new ConversionError(
        `Concept '${concept.id}' has no markdown representation. Available: check with read_concept.`
      );
    }
    return concept.markdown;
  }

  /** The stored thoughtform, re-validated: rows from 2.x may hold free-form JSON. */
  private requireThoughtForm(concept: ReadConcept): StoredThoughtForm {
    if (!concept.thoughtform) {
      throw new ConversionError(`Concept '${concept.id}' has no thoughtform representation.`);
    }
    const parsed = StoredThoughtFormSchema.safeParse(concept.thoughtform);
    if (!parsed.success) {
      throw new ConversionError(
        `Concept '${concept.id}' thoughtform matches neither the native nor the PolyVault v1 schema; re-save it with a valid thoughtform`
      );
    }
    return parsed.data;
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
      throw new ConversionError(`ThoughtForm validation failed: ${issues}`);
    }
  }
}

export const conversionService = new ConversionService();
