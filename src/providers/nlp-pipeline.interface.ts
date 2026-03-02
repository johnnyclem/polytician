import type { ThoughtFormEntities } from './llm.interface.js';

export interface NLPPipelineOptions {
  entityTypes?: string[];
  minConfidence?: number;
  inferRelationships?: boolean;
}

export interface NLPPipeline {
  readonly name: string;
  extractEntities(text: string, options?: NLPPipelineOptions): Promise<ThoughtFormEntities>;
}
