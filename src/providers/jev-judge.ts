/**
 * Jev judge for the decisions polytician already makes weakly.
 *
 * The rule-based pipeline assigns 0.55 to a single capitalized word and types
 * it ENTITY. Neighbor search breaks an equal-score tie by concept id. Those
 * are the only calls this judge is asked to make. It can only return a label
 * from the shortlist it was shown. Decline drops the weak guess; it does not
 * invent a type or a neighbor.
 *
 * Request shape matches @typesafe-ai/sdk 0.6.0: POST {base}/v1/systemone,
 * answer at answers.<name>.
 */

export const JEV_ABSTAIN = '__none__';
/** Confidence the rule-based pipeline assigns a single capitalized word. */
export const LOW_ENTITY_CONFIDENCE = 0.55;
export const DEFAULT_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_ACCEPT = 0.7;

export interface JevChoice {
  id: string;
  description: string;
}

export interface JevChoiceVerdict {
  id: string | null;
  probability: number;
  confidence: number | null;
  reason: string;
}

export interface JevJudgeOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  acceptThreshold?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChoiceAnswer {
  type?: string;
  choice?: unknown;
  confidence?: unknown;
  probabilities?: Record<string, unknown>;
}

export class JevJudge {
  readonly endpoint: string;
  readonly model: string;
  readonly acceptThreshold: number;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevJudgeOptions) {
    if (!options.apiKey) throw new Error('JevJudge requires an apiKey');
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_JEV_ENDPOINT;
    this.model = options.model ?? 'jev-latest';
    this.acceptThreshold = options.acceptThreshold ?? DEFAULT_JEV_ACCEPT;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** True for the pipeline's weakest entity guess, not for 0.7 quoted or 0.75 multi-word. */
  static isLowEntity(confidence: number): boolean {
    return confidence <= LOW_ENTITY_CONFIDENCE;
  }

  async choose(state: string, question: string, choices: JevChoice[]): Promise<JevChoiceVerdict> {
    const allowed = new Set(choices.map(c => c.id));
    if (choices.length === 0) {
      return { id: null, probability: 0, confidence: null, reason: 'Jev was not asked: the shortlist was empty' };
    }
    const criteria: Record<string, string> = {};
    for (const choice of choices) criteria[choice.id] = choice.description.slice(0, 240);
    criteria[JEV_ABSTAIN] = 'None of these fit';

    let answer: ChoiceAnswer;
    try {
      answer = await this.ask(state, question, criteria);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'request failed';
      return { id: null, probability: 0, confidence: null, reason: `Jev declined: ${message}` };
    }

    const choice = typeof answer.choice === 'string' ? answer.choice : '';
    const raw = answer.probabilities?.[choice];
    const probability = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
    if (choice === '' || choice === JEV_ABSTAIN) {
      return { id: null, probability, confidence, reason: 'Jev abstained' };
    }
    if (!allowed.has(choice)) {
      return { id: null, probability, confidence, reason: `Jev declined: "${choice}" is not in the shortlist` };
    }
    if (probability < this.acceptThreshold) {
      return {
        id: null,
        probability,
        confidence,
        reason: `Jev declined ${choice}: probability ${probability.toFixed(3)} is below ${this.acceptThreshold}`,
      };
    }
    return { id: choice, probability, confidence, reason: `Jev approved ${choice} at ${probability.toFixed(3)}` };
  }

  private async ask(state: string, question: string, criteria: Record<string, string>): Promise<ChoiceAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          state,
          questions: {
            pick: { type: 'choice', instructions: question, criteria },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { answers?: { pick?: ChoiceAnswer } };
      const answer = body.answers?.pick;
      if (!answer || answer.type !== 'choice') throw new Error('response had no choice answer');
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }
}
