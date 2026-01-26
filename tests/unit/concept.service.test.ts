/**
 * Unit tests for Concept Service
 */

import { describe, it, expect, jest } from '@jest/globals';

describe('ConceptService', () => {
  // Simple unit tests that don't require complex mocking
  
  describe('ConceptService Structure', () => {
    it('should have ConceptService class available', async () => {
      const { conceptService } = await import('../../dist/services/concept.service.js');
      expect(conceptService).toBeDefined();
      expect(typeof conceptService.saveVector).toBe('function');
      expect(typeof conceptService.saveMarkdown).toBe('function');
      expect(typeof conceptService.saveThoughtForm).toBe('function');
      expect(typeof conceptService.readVector).toBe('function');
      expect(typeof conceptService.readMarkdown).toBe('function');
      expect(typeof conceptService.readThoughtForm).toBe('function');
      expect(typeof conceptService.listAll).toBe('function');
      expect(typeof conceptService.delete).toBe('function');
      expect(typeof conceptService.getRepresentations).toBe('function');
      expect(typeof conceptService.generateId).toBe('function');
    });

    it('should generate valid UUIDs', async () => {
      const { conceptService } = await import('../../dist/services/concept.service.js');
      const id1 = conceptService.generateId();
      const id2 = conceptService.generateId();
      
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  describe('Vector Utilities', () => {
    it('should validate vector dimensions correctly', async () => {
      const { conceptService } = await import('../../dist/services/concept.service.js');
      
      // This should fail because vector has wrong dimensions
      await expect(conceptService.saveVector('test', Array(100).fill(0.1)))
        .rejects.toThrow('Vector dimension mismatch: expected 768, got 100');
    });
  });

  describe('Type System Tests', () => {
    it('should import types correctly', async () => {
      const conceptTypes = await import('../../dist/types/concept.js');
      const thoughtFormTypes = await import('../../dist/types/thoughtform.js');
      
      expect(conceptTypes).toBeDefined();
      expect(thoughtFormTypes).toBeDefined();
    });

    it('should import schema correctly', async () => {
      const schema = await import('../../dist/db/schema.js');
      
      expect(schema.concepts).toBeDefined();
      expect(typeof schema.concepts).toBe('function');
    });
  });
});