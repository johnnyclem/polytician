/**
 * Database Transaction Utilities
 *
 * Provides transaction management for data consistency across multiple operations.
 */

import { db } from './client.js';
import { eq } from 'drizzle-orm';

/**
 * Execute multiple operations in a transaction for consistency
 */
export async function executeInTransaction<T>(
  operations: Array<() => Promise<T>>
): Promise<T[]> {
  const results: T[] = [];
  
  // Use Drizzle's transaction API
  const tx = db.transaction(async (tx) => {
    for (const operation of operations) {
      const result = await operation();
      results.push(result);
    }
    return results;
  });
  
  return await tx;
}

/**
 * Conditional update - only if record exists
 */
export async function updateIfExists(
  table: any,
  id: string,
  data: any,
  idField: string = 'id'
): Promise<{ updated: boolean; record: any }> {
  return db.transaction(async (tx) => {
    // Check if exists using transaction
    const existing = await tx.select().from(table).where(eq(table[idField], id)).limit(1);
    
    if (existing.length === 0) {
      return { updated: false, record: null };
    }
    
    // Update the record
    await tx.update(table).set(data).where(eq(table[idField], id));
    
    // Return updated record
    const updated = await tx.select().from(table).where(eq(table[idField], id)).limit(1);
    return { updated: true, record: updated[0] || null };
  });
}

/**
 * Atomic save operation - insert or update
 */
export async function atomicSave(
  table: any,
  id: string,
  data: any,
  idField: string = 'id'
): Promise<{ created: boolean; updated: boolean }> {
  return db.transaction(async (tx) => {
    // Check if exists
    const existing = await tx.select().from(table).where(eq(table[idField], id)).limit(1);
    
    if (existing.length === 0) {
      // Insert new record
      await tx.insert(table).values({ [idField]: id, ...data });
      return { created: true, updated: false };
    } else {
      // Update existing record
      await tx.update(table).set(data).where(eq(table[idField], id));
      return { created: false, updated: true };
    }
  });
}