export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface ThoughtFormEntities {
  entities: Array<{
    id: string;
    text: string;
    type: string;
    confidence: number;
    offset: { start: number; end: number };
  }>;
  relationships: Array<{
    subjectId: string;
    predicate: string;
    objectId: string;
    confidence?: number;
  }>;
  contextGraph: Record<string, string[]>;
}

export interface LLMProvider {
  readonly name: string;
  complete(prompt: string, options?: LLMOptions): Promise<string>;
  extractEntities(text: string): Promise<ThoughtFormEntities>;
  summarize(texts: string[]): Promise<string>;
}
