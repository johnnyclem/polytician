/**
 * Jest setup file for unit tests
 */

import { jest } from '@jest/globals';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.SIDECAR_HOST = '127.0.0.1';
process.env.SIDECAR_PORT = '8787';

// Global test utilities
(global as any).testUtils = {
  // Create mock concept data
  createMockConcept: (overrides = {}) => ({
    id: 'test-concept-id',
    createdAt: new Date(),
    updatedAt: new Date(),
    tags: [],
    vectorBlob: null,
    mdBlob: null,
    thoughtformBlob: null,
    ...overrides,
  }),

  // Create mock ThoughtForm
  createMockThoughtForm: (overrides = {}) => ({
    id: 'test-thoughtform-id',
    rawText: 'This is a test concept with some content.',
    language: 'en',
    metadata: {
      timestamp: new Date().toISOString(),
      author: null,
      tags: ['test'],
      source: 'test',
    },
    entities: [],
    relationships: [],
    contextGraph: {},
    embeddings: [],
    ...overrides,
  }),

  // Create mock vector
  createMockVector: (dimension = 768) => 
    Array.from({ length: dimension }, () => Math.random() - 0.5),
};

// Set default timeout for async operations
jest.setTimeout(30000);