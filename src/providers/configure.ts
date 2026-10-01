import type { PolyticianConfig } from '../config.js';
import { ConfigurationError } from '../errors/index.js';
import { conversionService } from '../services/conversion.service.js';
import { logger } from '../logger.js';

/**
 * Install the LLM provider and NLP pipeline the operator configured. Content
 * only leaves the machine for LLM conversions when llm.provider is
 * 'agentvault' explicitly; configuring AgentVault for sync or archival does
 * not route conversions through its inference chain.
 */
export async function configureProviders(config: PolyticianConfig): Promise<void> {
  if (config.llm.provider === 'agentvault') {
    if (!config.agentVault) {
      throw new ConfigurationError(
        'POLYTICIAN_LLM_PROVIDER=agentvault needs the AgentVault integration (POLYTICIAN_AV_API_URL, or agentVault in the config file)'
      );
    }
    const { AgentVaultLLMProvider } =
      await import('../integrations/agent-vault/providers/agentvault-llm.provider.js');
    conversionService.setLLMProvider(new AgentVaultLLMProvider(config.agentVault));
    logger.info('llm provider set to agentvault', { endpoint: config.agentVault.apiBaseUrl });
  }

  // Used by markdown→thoughtform conversion.
  if (config.nlp.pipeline === 'rule-based') {
    const { RuleBasedNLPPipeline } = await import('./rule-based-nlp.pipeline.js');
    conversionService.setNLPPipeline(new RuleBasedNLPPipeline());
    logger.info('nlp pipeline set to rule-based');
  }
}
