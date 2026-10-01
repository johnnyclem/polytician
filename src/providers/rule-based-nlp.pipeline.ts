import type { ThoughtFormEntities } from './llm.interface.js';
import type { NLPPipeline, NLPPipelineOptions } from './nlp-pipeline.interface.js';

interface RawEntity {
  id: string;
  text: string;
  type: string;
  confidence: number;
  offset: { start: number; end: number };
}

interface RawRelationship {
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
}

interface Mention {
  entity: RawEntity;
  start: number;
  end: number;
}

interface EntityIndex {
  byText: Map<string, RawEntity>;
  unindexed: RawEntity[];
  maxWords: number;
}

/** Entity mentions considered per sentence (a bullet or run-on line can name hundreds). */
const MAX_MENTIONS_PER_SENTENCE = 64;

/** Longest entity, in words, looked up at word boundaries. */
const MAX_ENTITY_WORDS = 8;

/** Entities that cannot be looked up by words and are searched for directly instead. */
const MAX_UNINDEXED_ENTITIES = 256;

/** Relationships inferred per text. */
const MAX_RELATIONSHIPS = 5000;

const VERB_PATTERNS = [
  /^(?:,?\s*who\s+)?(\w+ed)\s/,
  /^(?:,?\s*who\s+)?(\w+s)\s/,
  /^(?:,?\s*who\s+)?(\w+)\s/,
  /^(\w+ed)$/,
  /^(\w+s)$/,
  /^(\w+)$/,
];

const NON_VERBS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'over',
]);

/**
 * Rule-based NLP pipeline that extracts entities using pattern matching
 * and infers relationships using dependency-style parsing.
 * Works without any external API or LLM.
 */
export class RuleBasedNLPPipeline implements NLPPipeline {
  readonly name = 'rule-based';

  async extractEntities(text: string, options?: NLPPipelineOptions): Promise<ThoughtFormEntities> {
    const minConfidence = options?.minConfidence ?? 0.5;
    const allowedTypes = options?.entityTypes;

    let entities = this.findEntities(text);

    if (allowedTypes) {
      entities = entities.filter(e => allowedTypes.includes(e.type));
    }
    entities = entities.filter(e => e.confidence >= minConfidence);

    const relationships =
      options?.inferRelationships !== false ? this.inferRelationships(text, entities) : [];

    const contextGraph = this.buildContextGraph(entities, relationships);

    return { entities, relationships, contextGraph };
  }

  private findEntities(text: string): RawEntity[] {
    const entities: RawEntity[] = [];
    const seen = new Set<string>();
    let counter = 0;

    // Pattern 1: Capitalized multi-word sequences (PERSON, ORGANIZATION)
    // Allows name connectors like "of", "de", "van", "von" but not conjunctions like "and"
    const multiCapRegex = /\b([A-Z][a-z]+(?:\s+(?:(?:of|the|de|van|von)\s+)?[A-Z][a-z]+)+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = multiCapRegex.exec(text)) !== null) {
      const entityText = match[1] ?? '';
      if (!entityText) continue;
      const key = entityText.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        id: `ent_${counter++}`,
        text: entityText,
        type: this.classifyCapitalizedEntity(entityText),
        confidence: 0.75,
        offset: { start: match.index, end: match.index + entityText.length },
      });
    }

    // Pattern 2: Quoted or backtick-wrapped terms (CONCEPT)
    const quotedRegex = /[""`]([^"""`]+)[""`]/g;
    while ((match = quotedRegex.exec(text)) !== null) {
      const entityText = match[1] ?? '';
      if (!entityText) continue;
      const key = entityText.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        id: `ent_${counter++}`,
        text: entityText,
        type: 'CONCEPT',
        confidence: 0.7,
        offset: { start: match.index + 1, end: match.index + 1 + entityText.length },
      });
    }

    // Pattern 3: Single capitalized words mid-sentence (not sentence starters)
    const singleCapRegex = /(?<=[a-z,.;:!?]\s)([A-Z][a-z]{2,})\b/g;
    while ((match = singleCapRegex.exec(text)) !== null) {
      const entityText = match[1] ?? '';
      const key = entityText.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        id: `ent_${counter++}`,
        text: entityText,
        type: 'ENTITY',
        confidence: 0.55,
        offset: { start: match.index, end: match.index + entityText.length },
      });
    }

    return entities;
  }

  private classifyCapitalizedEntity(text: string): string {
    const words = text.split(/\s+/);
    // Heuristics for entity type classification
    const orgIndicators = [
      'Inc',
      'Corp',
      'Ltd',
      'University',
      'Institute',
      'Foundation',
      'Company',
      'Organization',
      'Association',
      'Department',
      'Agency',
      'Committee',
    ];
    const locationIndicators = [
      'City',
      'State',
      'County',
      'River',
      'Mountain',
      'Lake',
      'Ocean',
      'Sea',
      'Island',
      'Park',
      'Street',
    ];

    for (const word of words) {
      if (orgIndicators.includes(word)) return 'ORGANIZATION';
      if (locationIndicators.includes(word)) return 'LOCATION';
    }

    // Default: if 2-3 words and all capitalized, likely a PERSON
    if (words.length >= 2 && words.length <= 3) return 'PERSON';
    return 'ENTITY';
  }

  /**
   * Infer relationships using dependency-style parsing:
   * - Subject-verb-object patterns between entities in the same sentence
   * - "X is a/an Y" → is_a relationship
   * - "X [verb] Y" → verb relationship
   *
   * Sentences end at . ! ? and at line breaks (so each bullet is its own
   * sentence). Only neighbouring mentions are paired, and mentions are found
   * by a word-start lookup, so the cost is linear in the text and the number
   * of mentions rather than cubic in the number of entities.
   */
  private inferRelationships(text: string, entities: RawEntity[]): RawRelationship[] {
    const relationships: RawRelationship[] = [];
    const index = this.indexEntities(entities);

    for (const sentence of text.split(/[.!?]+|\n+/)) {
      if (relationships.length >= MAX_RELATIONSHIPS) break;
      const sentLower = sentence.toLowerCase();
      const mentions = this.findMentions(sentLower, index);
      for (let i = 0; i + 1 < mentions.length; i++) {
        const subj = mentions[i];
        const obj = mentions[i + 1];
        if (!subj || !obj) continue;
        const predicate = this.extractPredicate(sentLower, subj, obj);
        if (predicate) {
          relationships.push({
            subjectId: subj.entity.id,
            predicate,
            objectId: obj.entity.id,
            confidence: this.predicateConfidence(predicate),
          });
          if (relationships.length >= MAX_RELATIONSHIPS) break;
        }
      }
    }

    return relationships;
  }

  /**
   * Entities by lower-cased text, for lookup at word boundaries. Entities that
   * do not start and end with a word character, or span more than
   * MAX_ENTITY_WORDS words, are searched for directly (at most
   * MAX_UNINDEXED_ENTITIES of them).
   */
  private indexEntities(entities: RawEntity[]): EntityIndex {
    const byText = new Map<string, RawEntity>();
    const unindexed: RawEntity[] = [];
    let maxWords = 1;
    for (const entity of entities) {
      const lower = entity.text.toLowerCase();
      const words = lower.match(/\w+/g)?.length ?? 0;
      if (words > 0 && words <= MAX_ENTITY_WORDS && /^\w/.test(lower) && /\w$/.test(lower)) {
        if (!byText.has(lower)) byText.set(lower, entity);
        maxWords = Math.max(maxWords, words);
      } else if (unindexed.length < MAX_UNINDEXED_ENTITIES) {
        unindexed.push(entity);
      }
    }
    return { byText, unindexed, maxWords };
  }

  /**
   * First mention of each entity in a lower-cased sentence, in order of
   * position (at most MAX_MENTIONS_PER_SENTENCE). A mention must start and
   * end on word boundaries: each run of 1..maxWords words is looked up once.
   */
  private findMentions(sentLower: string, index: EntityIndex): Mention[] {
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    const add = (entity: RawEntity, start: number, end: number): void => {
      if (seen.has(entity.id)) return;
      seen.add(entity.id);
      mentions.push({ entity, start, end });
    };

    const starts: number[] = [];
    const ends: number[] = [];
    const word = /\w+/g;
    let match: RegExpExecArray | null;
    while ((match = word.exec(sentLower)) !== null) {
      starts.push(match.index);
      ends.push(match.index + match[0].length);
    }
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i] ?? 0;
      for (let j = i; j < Math.min(starts.length, i + index.maxWords); j++) {
        const end = ends[j] ?? start;
        const entity = index.byText.get(sentLower.slice(start, end));
        if (entity) add(entity, start, end);
      }
    }
    for (const entity of index.unindexed) {
      const start = sentLower.indexOf(entity.text.toLowerCase());
      if (start !== -1) add(entity, start, start + entity.text.length);
    }

    mentions.sort((a, b) => a.start - b.start || b.end - a.end);
    return mentions.slice(0, MAX_MENTIONS_PER_SENTENCE);
  }

  /**
   * Extract the predicate (verb phrase) between two neighbouring mentions in a sentence.
   */
  private extractPredicate(sentence: string, subj: Mention, obj: Mention): string | null {
    if (subj.end >= obj.start) return null;

    const between = sentence.slice(subj.end, obj.start).trim();

    // Check for common relationship patterns
    const isAMatch = /^(?:is|was|were|are)\s+(?:a|an|the)\s+/i.exec(between);
    if (isAMatch) return 'is_a';

    for (const pattern of VERB_PATTERNS) {
      const verbMatch = pattern.exec(between);
      if (verbMatch?.[1]) {
        const verb = verbMatch[1];
        // Filter out common non-verb words
        if (!NON_VERBS.has(verb)) return verb;
      }
    }

    return null;
  }

  private predicateConfidence(predicate: string): number {
    if (predicate === 'is_a') return 0.85;
    if (predicate.endsWith('ed')) return 0.75;
    if (predicate.endsWith('s')) return 0.7;
    return 0.6;
  }

  private buildContextGraph(
    entities: RawEntity[],
    relationships: RawRelationship[]
  ): Record<string, string[]> {
    const graph: Record<string, string[]> = {};

    for (const rel of relationships) {
      if (!graph[rel.subjectId]) graph[rel.subjectId] = [];
      if (!graph[rel.objectId]) graph[rel.objectId] = [];
      const subjConns = graph[rel.subjectId] ?? [];
      const objConns = graph[rel.objectId] ?? [];
      if (!subjConns.includes(rel.objectId)) {
        subjConns.push(rel.objectId);
      }
      if (!objConns.includes(rel.subjectId)) {
        objConns.push(rel.subjectId);
      }
    }

    return graph;
  }
}
