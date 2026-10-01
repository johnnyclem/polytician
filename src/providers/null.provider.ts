import type {
  LLMProvider,
  LLMOptions,
  SummarizeOptions,
  ThoughtFormEntities,
} from './llm.interface.js';

export class NullProvider implements LLMProvider {
  readonly name = 'none';

  async complete(_prompt: string, _options?: LLMOptions): Promise<string> {
    throw new Error(
      'No LLM provider is configured. The only provider is AgentVault inference: set POLYTICIAN_LLM_PROVIDER=agentvault (or llm.provider in the config file) together with the AgentVault integration.'
    );
  }

  async extractEntities(_text: string): Promise<ThoughtFormEntities> {
    throw new Error(
      'Entity extraction requires an LLM provider (POLYTICIAN_LLM_PROVIDER=agentvault) or POLYTICIAN_NLP_PIPELINE=rule-based.'
    );
  }

  async summarize(_texts: string[], _options?: SummarizeOptions): Promise<string> {
    throw new Error('Summarization requires an LLM provider (POLYTICIAN_LLM_PROVIDER=agentvault).');
  }
}
