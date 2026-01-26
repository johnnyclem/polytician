/**
 * Integration tests for Conversion Service
 * 
 * Tests the complete workflow of converting between different representations
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('ConversionService Integration Tests', () => {
  let conceptId: string;
  let testVector: number[];
  let testMarkdown: string;
  let testThoughtForm: any;

  beforeEach(() => {
    // Test data
    conceptId = 'test-conversion-' + Math.random().toString(36).substr(2, 9);
    testVector = Array.from({ length: 768 }, () => Math.random() - 0.5);
    testMarkdown = '# Test Concept\n\nThis is a test concept with **bold** text.';
    testThoughtForm = {
      id: conceptId,
      rawText: 'This is a test concept with bold text.',
      language: 'en',
      metadata: {
        timestamp: new Date().toISOString(),
        author: null,
        tags: ['test', 'integration'],
        source: 'test',
      },
      entities: [
        {
          id: 'ent_1',
          text: 'Test Concept',
          type: 'WORK_OF_ART',
          confidence: 0.9,
          offset: { start: 0, end: 12 },
        },
        {
          id: 'ent_2',
          text: 'bold',
          type: 'STYLE',
          confidence: 0.8,
          offset: { start: 35, end: 40 },
        },
      ],
      relationships: [],
      contextGraph: {},
    };
  });

  afterEach(async () => {
    // Cleanup test data
    try {
      const { conceptService } = await import('../../dist/services/concept.service.js');
      await conceptService.delete(conceptId).catch(() => {}); // Ignore cleanup errors
    } catch {
      // Ignore cleanup errors in integration tests
    }
  });

  describe('Complete Conversion Workflows', () => {
    it('should convert ThoughtForm -> Vector -> Markdown -> ThoughtForm', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Save initial ThoughtForm
      await conceptService.saveThoughtForm(conceptId, testThoughtForm);
      
      // Convert ThoughtForm to Vector
      const vector = await conversionService.convert(conceptId, 'thoughtForm', 'vectors');
      expect(vector).toEqual(testVector);
      
      // Convert Vector to Markdown
      const markdown = await conversionService.convert(conceptId, 'vectors', 'md');
      expect(typeof markdown).toBe('string');
      expect(markdown).toContain('#');
      
      // Convert Markdown to ThoughtForm
      const thoughtForm = await conversionService.convert(conceptId, 'md', 'thoughtForm');
      expect(thoughtForm).toHaveProperty('rawText');
      expect(thoughtForm).toHaveProperty('entities');
      expect(thoughtForm.id).toBe(conceptId);
    }, 30000);

    it('should convert Markdown -> Vector -> ThoughtForm -> Markdown', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Save initial Markdown
      await conceptService.saveMarkdown(conceptId, testMarkdown);
      
      // Convert Markdown to Vector
      const vector = await conversionService.convert(conceptId, 'md', 'vectors');
      expect(Array.isArray(vector)).toBe(true);
      expect(vector).toHaveLength(768);
      
      // Convert Vector to ThoughtForm
      const thoughtForm = await conversionService.convert(conceptId, 'vectors', 'thoughtForm');
      expect(thoughtForm).toHaveProperty('rawText');
      expect(thoughtForm).toHaveProperty('language');
      
      // Convert ThoughtForm to Markdown
      const markdown = await conversionService.convert(conceptId, 'thoughtForm', 'md');
      expect(typeof markdown).toBe('string');
      expect(markdown).toContain('#');
    }, 30000);

    it('should handle bidirectional conversions consistently', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Save initial data
      await conceptService.saveThoughtForm(conceptId, testThoughtForm);
      
      // Convert in a cycle
      const vector = await conversionService.convert(conceptId, 'thoughtForm', 'vectors');
      const markdown = await conversionService.convert(conceptId, 'vectors', 'md');
      const finalThoughtForm = await conversionService.convert(conceptId, 'md', 'thoughtForm');
      
      // Verify consistency
      expect(finalThoughtForm.id).toBe(testThoughtForm.id);
      expect(finalThoughtForm.language).toBe(testThoughtForm.language);
      expect(Array.isArray(finalThoughtForm.entities)).toBe(true);
    }, 45000);
  });

  describe('Error Handling in Conversions', () => {
    it('should handle missing source data gracefully', async () => {
      const { conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Try to convert from non-existent representation
      await expect(conversionService.convert('non-existent-id', 'thoughtForm', 'vectors'))
        .rejects.toThrow();
    });

    it('should validate conversion parameters', async () => {
      const { conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Try to convert to same type
      await expect(conversionService.convert(conceptId, 'thoughtForm', 'thoughtForm'))
        .rejects.toThrow('Cannot convert thoughtForm to itself');
    });

    it('should handle invalid conversion paths', async () => {
      const { conversionService } = await import('../../dist/services/conversion.service.js');
      
      await expect(conversionService.convert(conceptId, 'invalid' as any, 'vectors' as any))
        .rejects.toThrow('Unknown conversion');
    });
  });

  describe('Integration with Database', () => {
    it('should persist all conversion results', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Save ThoughtForm
      await conceptService.saveThoughtForm(conceptId, testThoughtForm);
      
      // Convert to Vector and Markdown
      await conversionService.convert(conceptId, 'thoughtForm', 'vectors');
      await conversionService.convert(conceptId, 'thoughtForm', 'md');
      
      // Verify all representations exist
      const reps = await conceptService.getRepresentations(conceptId);
      expect(reps.vectors).toBe(true);
      expect(reps.md).toBe(true);
      expect(reps.thoughtForm).toBe(true);
    }, 30000);

    it('should maintain data integrity across conversions', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Save initial data
      await conceptService.saveThoughtForm(conceptId, testThoughtForm);
      
      // Perform conversions
      await conversionService.convert(conceptId, 'thoughtForm', 'vectors');
      await conversionService.convert(conceptId, 'vectors', 'thoughtForm');
      
      // Verify data integrity
      const finalThoughtForm = await conceptService.readThoughtForm(conceptId);
      expect(finalThoughtForm?.id).toBe(testThoughtForm.id);
      expect(finalThoughtForm?.rawText).toBe(testThoughtForm.rawText);
    }, 30000);
  });

  describe('Performance and Scalability', () => {
    it('should handle multiple concurrent conversions', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Create multiple concepts
      const concepts = Array.from({ length: 3 }, (_, i) => ({
        id: `${conceptId}-${i}`,
        ...testThoughtForm,
        id: `${conceptId}-${i}`,
      }));
      
      // Save all concepts
      await Promise.all(concepts.map(async (c) => 
        conceptService.saveThoughtForm(c.id, c)
      ));
      
      // Perform concurrent conversions
      const conversions = concepts.map(async (c) => 
        conversionService.convert(c.id, 'thoughtForm', 'vectors')
      );
      
      const results = await Promise.all(conversions);
      expect(results).toHaveLength(3);
      results.forEach(vector => {
        expect(Array.isArray(vector)).toBe(true);
        expect(vector).toHaveLength(768);
      });
    }, 60000);

    it('should complete conversions within reasonable time', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Save initial data
      await conceptService.saveThoughtForm(conceptId, testThoughtForm);
      
      // Measure conversion time
      const startTime = Date.now();
      await conversionService.convert(conceptId, 'thoughtForm', 'vectors');
      const endTime = Date.now();
      
      // Should complete within 30 seconds
      expect(endTime - startTime).toBeLessThan(30000);
    }, 35000);
  });

  describe('Real-world Scenarios', () => {
    it('should handle large content conversions', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Create large content
      const largeMarkdown = '# Large Document\n\n' + 'This is a large paragraph. '.repeat(100);
      
      // Save and convert
      await conceptService.saveMarkdown(conceptId, largeMarkdown);
      const vector = await conversionService.convert(conceptId, 'md', 'vectors');
      
      expect(Array.isArray(vector)).toBe(true);
      expect(vector).toHaveLength(768);
    }, 45000);

    it('should handle multilingual content', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Create multilingual ThoughtForm
      const multilingualTF = {
        ...testThoughtForm,
        language: 'fr',
        rawText: 'Ceci est un concept multilingue avec des émoticons 😊.',
      };
      
      // Save and convert
      await conceptService.saveThoughtForm(conceptId, multilingualTF);
      const vector = await conversionService.convert(conceptId, 'thoughtForm', 'vectors');
      const markdown = await conversionService.convert(conceptId, 'thoughtForm', 'md');
      
      expect(Array.isArray(vector)).toBe(true);
      expect(typeof markdown).toBe('string');
      expect(markdown).toContain('Ceci est');
    }, 30000);

    it('should handle complex entity relationships', async () => {
      const { conceptService, conversionService } = await import('../../dist/services/conversion.service.js');
      
      // Create complex ThoughtForm
      const complexTF = {
        ...testThoughtForm,
        entities: [
          {
            id: 'ent_1',
            text: 'Apple',
            type: 'ORG',
            confidence: 0.9,
            offset: { start: 0, end: 5 },
          },
          {
            id: 'ent_2', 
            text: 'Steve Jobs',
            type: 'PERSON',
            confidence: 0.95,
            offset: { start: 10, end: 20 },
          },
        ],
        relationships: [
          {
            subjectId: 'ent_2',
            predicate: 'co-founded',
            objectId: 'ent_1',
            confidence: 0.8,
          },
        ],
        contextGraph: {
          'ent_1': ['ent_2'],
          'ent_2': ['ent_1'],
        },
      };
      
      // Save and convert
      await conceptService.saveThoughtForm(conceptId, complexTF);
      const markdown = await conversionService.convert(conceptId, 'thoughtForm', 'md');
      
      expect(markdown).toContain('Apple');
      expect(markdown).toContain('Steve Jobs');
      expect(markdown).toContain('co-founded');
    }, 30000);
  });
});