import { ZodError, type ZodSchema } from 'zod';
import {
  ThoughtFormV1Schema,
  BundleV1Schema,
  ChunkSchema,
} from '../../schemas/index.js';
import type { ThoughtFormV1, BundleV1, Chunk } from '../../schemas/index.js';

// --- PolyVault schema parser / validator ---
// Wraps Zod schemas with structured result types for CLI consumption.
// All parsers use .passthrough() schemas so unknown fields survive roundtrips.

export interface ParseSuccess<T> {
  ok: true;
  data: T;
}

export interface ParseFailure {
  ok: false;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

function formatZodErrors(err: ZodError): ValidationError[] {
  return err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

function safeParse<T>(schema: ZodSchema<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodErrors(result.error) };
}

export function parseThoughtForm(input: unknown): ParseResult<ThoughtFormV1> {
  return safeParse(ThoughtFormV1Schema, input);
}

export function parseBundle(input: unknown): ParseResult<BundleV1> {
  return safeParse(BundleV1Schema, input);
}

export function parseChunk(input: unknown): ParseResult<Chunk> {
  return safeParse(ChunkSchema, input);
}

export function parseThoughtFormOrThrow(input: unknown): ThoughtFormV1 {
  return ThoughtFormV1Schema.parse(input);
}

export function parseBundleOrThrow(input: unknown): BundleV1 {
  return BundleV1Schema.parse(input);
}

export function parseChunkOrThrow(input: unknown): Chunk {
  return ChunkSchema.parse(input);
}
