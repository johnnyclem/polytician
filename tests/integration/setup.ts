/**
 * Jest setup for integration tests
 */

import { jest } from '@jest/globals';

// Integration test specific setup
process.env.NODE_ENV = 'test';
process.env.DB_PATH = './test-integration.db';

// Extended timeout for integration tests
jest.setTimeout(60000);