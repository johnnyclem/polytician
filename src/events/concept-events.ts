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

/**
 * In-process event bus for concept lifecycle events.
 *
 * In a single-node deployment this keeps listeners decoupled from the
 * ConceptService.  In a distributed deployment the emit calls can be
 * replaced (or augmented) with a publish to an external message broker
 * (e.g. Redis Pub/Sub, Kafka) so that all nodes receive the event and
 * can synchronise their local vector indexes accordingly.
 */
class ConceptEventBus extends EventEmitter {
  emit(event: 'concept.created', payload: ConceptCreatedPayload): boolean;
  emit(event: 'concept.updated', payload: ConceptUpdatedPayload): boolean;
  emit(event: 'concept.deleted', payload: ConceptDeletedPayload): boolean;
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: 'concept.created', listener: (payload: ConceptCreatedPayload) => void): this;
  on(event: 'concept.updated', listener: (payload: ConceptUpdatedPayload) => void): this;
  on(event: 'concept.deleted', listener: (payload: ConceptDeletedPayload) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off(event: 'concept.created', listener: (payload: ConceptCreatedPayload) => void): this;
  off(event: 'concept.updated', listener: (payload: ConceptUpdatedPayload) => void): this;
  off(event: 'concept.deleted', listener: (payload: ConceptDeletedPayload) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const conceptEventBus = new ConceptEventBus();
