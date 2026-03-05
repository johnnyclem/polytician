import type {
  LLMProvider,
  LLMOptions,
  SummarizeOptions,
  ThoughtFormEntities,
} from '../../../providers/llm.interface.js';
import type { AgentVaultConfig } from '../config.js';
import { InferenceClient } from '../client/inference-client.js';
import { logger } from '../../../logger.js';

/**
 * LLMProvider that delegates to AgentVault's InferenceFallbackChain.
 * Tries Bittensor -> Venice AI -> local model in sequence.
 */
export class AgentVaultLLMProvider implements LLMProvider {
  readonly name = 'agentvault';

  private readonly client: InferenceClient;
  private readonly config: AgentVaultConfig;

  constructor(config: AgentVaultConfig) {
    this.config = config;
    this.client = new InferenceClient(config);
  }

  async complete(prompt: string, options?: LLMOptions): Promise<string> {
    logger.debug('av-llm complete', { promptLen: prompt.length });
    const res = await this.client.infer({
      prompt,
      preferredBackend: this.config.inference.preferredBackend,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      systemPrompt: options?.systemPrompt,
    });
    return res.text;
  }

  async extractEntities(text: string): Promise<ThoughtFormEntities> {
    const systemPrompt = [
      'Extract named entities and relationships from the following text.',
      'Return a JSON object with this exact shape:',
      '{',
      '  "entities": [{"id":"ent_0","text":"...","type":"PERSON|ORGANIZATION|LOCATION|CONCEPT","confidence":0.9,"offset":{"start":0,"end":10}}],',
      '  "relationships": [{"subjectId":"ent_0","predicate":"founded","objectId":"ent_1","confidence":0.8}],',
      '  "contextGraph": {"ent_0":["ent_1"]}',
      '}',
      'Return only the JSON object, no markdown fences.',
    ].join('\n');

    const res = await this.client.infer({
      prompt: text,
      systemPrompt,
      preferredBackend: this.config.inference.preferredBackend,
      maxTokens: 2048,
      temperature: 0.0,
    });

    try {
      return JSON.parse(res.text) as ThoughtFormEntities;
    } catch {
      logger.warn('av-llm entity parse failed, returning empty', { backend: res.backend });
      return { entities: [], relationships: [], contextGraph: {} };
    }
  }

  async summarize(texts: string[], options?: SummarizeOptions): Promise<string> {
    const context = texts.join('\n\n---\n\n');
    const systemPrompt = [
      'Synthesize the following related text excerpts into a single coherent markdown document.',
      'Use a # heading for the title, ## headings for major sections.',
      'Preserve key facts and relationships.',
    ].join('\n');

    const prompt = options?.conceptId
      ? `Concept ID: ${options.conceptId}\n\n${context}`
      : context;

    const res = await this.client.infer({
      prompt,
      systemPrompt,
      preferredBackend: this.config.inference.preferredBackend,
      maxTokens: 4096,
      temperature: 0.3,
    });
    return res.text;
  }
}
