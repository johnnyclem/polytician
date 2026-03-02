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
   */
  private inferRelationships(text: string, entities: RawEntity[]): RawRelationship[] {
    const relationships: RawRelationship[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

    for (const sentence of sentences) {
      const sentLower = sentence.toLowerCase();
      const presentEntities = entities.filter(e => sentLower.includes(e.text.toLowerCase()));

      if (presentEntities.length < 2) continue;

      // Try to find verb patterns between each pair of entities
      for (let i = 0; i < presentEntities.length; i++) {
        for (let j = i + 1; j < presentEntities.length; j++) {
          const subj = presentEntities[i];
          const obj = presentEntities[j];
          if (!subj || !obj) continue;
          const predicate = this.extractPredicate(
            sentLower,
            subj.text.toLowerCase(),
            obj.text.toLowerCase()
          );
          if (predicate) {
            relationships.push({
              subjectId: subj.id,
              predicate,
              objectId: obj.id,
              confidence: this.predicateConfidence(predicate),
            });
          }
        }
      }
    }

    return relationships;
  }

  /**
   * Extract the predicate (verb phrase) between two entity mentions in a sentence.
   */
  private extractPredicate(sentence: string, subjText: string, objText: string): string | null {
    const subjIdx = sentence.indexOf(subjText);
    const objIdx = sentence.indexOf(objText);
    if (subjIdx === -1 || objIdx === -1) return null;

    // Get text between the two entities
    const start = Math.min(subjIdx + subjText.length, objIdx + objText.length);
    const end = Math.max(subjIdx, objIdx);
    if (start >= end) return null;

    const between = sentence.slice(start, end).trim();

    // Check for common relationship patterns
    const isAMatch = /^(?:is|was|were|are)\s+(?:a|an|the)\s+/i.exec(between);
    if (isAMatch) return 'is_a';

    const verbPatterns = [
      /^(?:,?\s*who\s+)?(\w+ed)\s/,
      /^(?:,?\s*who\s+)?(\w+s)\s/,
      /^(?:,?\s*who\s+)?(\w+)\s/,
      /^(\w+ed)$/,
      /^(\w+s)$/,
      /^(\w+)$/,
    ];

    for (const pattern of verbPatterns) {
      const verbMatch = pattern.exec(between);
      if (verbMatch?.[1]) {
        const verb = verbMatch[1];
        // Filter out common non-verb words
        const nonVerbs = new Set([
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
        if (!nonVerbs.has(verb)) return verb;
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
