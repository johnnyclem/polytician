import type { AgentVaultConfig } from '../config.js';
import { SecretClient } from '../client/secret-client.js';
import { logger } from '../../../logger.js';

/**
 * Fetches secrets from AgentVault and injects them into process.env
 * so that getConfig() picks them up.
 *
 * Called once during startup, before getConfig() produces its final
 * cached value. Failures are logged as warnings and do not abort startup.
 */
export class AgentVaultSecretProvider {
  private readonly client: SecretClient;
  private readonly secretsConfig: AgentVaultConfig['secrets'];

  constructor(config: AgentVaultConfig) {
    this.client = new SecretClient(config);
    this.secretsConfig = config.secrets;
  }

  async injectSecrets(): Promise<void> {
    const { llmApiKey } = this.secretsConfig;

    if (llmApiKey && !process.env['POLYTICIAN_LLM_API_KEY']) {
      try {
        const secret = await this.client.getSecret(llmApiKey);
        process.env['POLYTICIAN_LLM_API_KEY'] = secret.value;
        logger.info('av-secret injected llm api key', { provider: secret.provider });
      } catch (err) {
        logger.warn('av-secret failed to fetch llm api key', {
          secretName: llmApiKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
