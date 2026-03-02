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
      'LLM provider not configured. Set "llm.provider" in .polytician.json or set POLYTICIAN_LLM_PROVIDER environment variable. Supported providers: anthropic, openai, sampling.'
    );
  }

  async extractEntities(_text: string): Promise<ThoughtFormEntities> {
    throw new Error(
      'Entity extraction requires an LLM provider. Configure one in .polytician.json or via environment variables.'
    );
  }

  async summarize(_texts: string[], _options?: SummarizeOptions): Promise<string> {
    throw new Error(
      'Summarization requires an LLM provider. Configure one in .polytician.json or via environment variables.'
    );
  }
}
