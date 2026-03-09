import { EventEmitter } from 'node:events';

export type ConceptEventType = 'concept.created' | 'concept.updated' | 'concept.deleted';

export interface ConceptCreatedPayload {
  conceptId: string;
  embedding: number[] | null;
  timestamp: number;
}

export interface ConceptUpdatedPayload {
  conceptId: string;
  embedding: number[] | null;
  timestamp: number;
}

export interface ConceptDeletedPayload {
  conceptId: string;
  timestamp: number;
}

type ConceptEventMap = {
  'concept.created': ConceptCreatedPayload;
  'concept.updated': ConceptUpdatedPayload;
  'concept.deleted': ConceptDeletedPayload;
};

class ConceptEventBus extends EventEmitter {
  override emit<E extends keyof ConceptEventMap>(event: E, payload: ConceptEventMap[E]): boolean {
    return super.emit(event, payload);
  }

  override on<E extends keyof ConceptEventMap>(
    event: E,
    listener: (payload: ConceptEventMap[E]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<E extends keyof ConceptEventMap>(
    event: E,
    listener: (payload: ConceptEventMap[E]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const conceptEventBus = new ConceptEventBus();
