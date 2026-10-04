import { describe, it, expect } from 'vitest';
import { JevJudge, JEV_ABSTAIN, LOW_ENTITY_CONFIDENCE } from '../src/providers/jev-judge.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('JevJudge', () => {
  it('treats only the pipeline 0.55 entity guess as low', () => {
    expect(JevJudge.isLowEntity(LOW_ENTITY_CONFIDENCE)).toBe(true);
    expect(JevJudge.isLowEntity(0.7)).toBe(false);
    expect(JevJudge.isLowEntity(0.75)).toBe(false);
  });

  it('accepts a shortlisted label and rejects one it was not shown', async () => {
    const accepted = new JevJudge({
      apiKey: 'test',
      fetch: async () =>
        jsonResponse({
          answers: { pick: { type: 'choice', choice: 'PERSON', probabilities: { PERSON: 0.81 }, confidence: 0.7 } },
        }),
    });
    const verdict = await accepted.choose('Ada Lovelace', 'What type is this span?', [
      { id: 'PERSON', description: 'A person' },
      { id: 'ENTITY', description: 'Unspecified' },
    ]);
    expect(verdict.id).toBe('PERSON');

    const rejected = new JevJudge({
      apiKey: 'test',
      fetch: async () =>
        jsonResponse({
          answers: { pick: { type: 'choice', choice: 'PLACE', probabilities: { PLACE: 0.99 }, confidence: 0.99 } },
        }),
    });
    const miss = await rejected.choose('Ada', 'What type is this span?', [
      { id: 'PERSON', description: 'A person' },
    ]);
    expect(miss.id).toBeNull();
    expect(miss.reason).toContain('not in the shortlist');
  });

  it('declines abstain and transport failure', async () => {
    const abstain = new JevJudge({
      apiKey: 'test',
      fetch: async () =>
        jsonResponse({
          answers: { pick: { type: 'choice', choice: JEV_ABSTAIN, probabilities: { [JEV_ABSTAIN]: 0.9 }, confidence: 0.8 } },
        }),
    });
    expect((await abstain.choose('x', 'q', [{ id: 'PERSON', description: 'A person' }])).id).toBeNull();

    const down = new JevJudge({
      apiKey: 'test',
      fetch: async () => {
        throw new Error('network down');
      },
    });
    const verdict = await down.choose('x', 'q', [{ id: 'PERSON', description: 'A person' }]);
    expect(verdict.id).toBeNull();
    expect(verdict.reason).toContain('network down');
  });
});
