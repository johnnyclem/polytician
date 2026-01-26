/**
 * Typed Error Classes for Politician MCP Server
 *
 * Provides a hierarchy of specific error types for better error handling
 * and debugging throughout the application.
 */

// Base error class for all Politician errors
export abstract class PoliticianError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    category: ErrorCategory,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.context = context;

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Get error details for logging
   */
  getDetails(): ErrorDetails {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      context: this.context,
      stack: this.stack,
    };
  }
}

// Error categories for classification
export enum ErrorCategory {
  VALIDATION = 'VALIDATION',
  DATABASE = 'DATABASE',
  NETWORK = 'NETWORK',
  ML_SERVICE = 'ML_SERVICE',
  CONVERSION = 'CONVERSION',
  CONFIGURATION = 'CONFIGURATION',
  NOT_FOUND = 'NOT_FOUND',
  PERMISSION = 'PERMISSION',
  SYSTEM = 'SYSTEM',
}

// Error details interface
export interface ErrorDetails {
  name: string;
  message: string;
  code: string;
  category: ErrorCategory;
  context?: Record<string, unknown>;
  stack?: string;
}

// Validation errors
export class ValidationError extends PoliticianError {
  constructor(message: string, field?: string, value?: unknown) {
    const context = field ? { field, value } : undefined;
    super(message, 'VALIDATION_ERROR', ErrorCategory.VALIDATION, context);
  }
}

export class DimensionMismatchError extends ValidationError {
  constructor(expected: number, actual: number) {
    super(
      `Vector dimension mismatch: expected ${expected}, got ${actual}`,
      'vector_dimension',
      { expected, actual }
    );
  }
}

export class UUIDFormatError extends ValidationError {
  constructor(id: string) {
    super(
      `Invalid UUID format: ${id}`,
      'concept_id',
      { id }
    );
  }
}

// Database errors
export class DatabaseError extends PoliticianError {
  constructor(message: string, operation?: string, table?: string, context?: Record<string, unknown>) {
    const errorContext = {
      operation,
      table,
      ...context,
    };
    super(message, 'DATABASE_ERROR', ErrorCategory.DATABASE, errorContext);
  }
}

export class NotFoundError extends DatabaseError {
  constructor(resource: string, id: string) {
    super(
      `${resource} with ID '${id}' not found`,
      'read',
      resource.toLowerCase(),
      { id }
    );
  }
}

export class DuplicateError extends DatabaseError {
  constructor(resource: string, id: string) {
    super(
      `${resource} with ID '${id}' already exists`,
      'create',
      resource.toLowerCase(),
      { id }
    );
  }
}

// Network/Service errors
export class NetworkError extends PoliticianError {
  constructor(message: string, url?: string, statusCode?: number) {
    const context = url ? { url, statusCode } : undefined;
    super(message, 'NETWORK_ERROR', ErrorCategory.NETWORK, context);
  }
}

export class TimeoutError extends NetworkError {
  constructor(operation: string, timeout: number) {
    super(
      `Operation '${operation}' timed out after ${timeout}ms`,
      undefined,
      408
    );
    this.name = 'TimeoutError';
  }
}

// ML Service errors
export class MLServiceError extends PoliticianError {
  constructor(message: string, service?: string, endpoint?: string) {
    const context = service ? { service, endpoint } : undefined;
    super(message, 'ML_SERVICE_ERROR', ErrorCategory.ML_SERVICE, context);
  }
}

export class EmbeddingError extends MLServiceError {
  constructor(message: string, textLength?: number) {
    super(message, 'embeddings', 'embed');
    if (textLength !== undefined && this.context) {
      (this.context as Record<string, unknown>).textLength = textLength;
    }
  }
}

export class NERError extends MLServiceError {
  constructor(message: string) {
    super(message, 'ner', 'extract-ner');
  }
}

export class VectorIndexError extends MLServiceError {
  constructor(message: string, operation?: string) {
    super(message, 'vector_index', operation);
  }
}

// Conversion errors
export class ConversionError extends PoliticianError {
  constructor(
    message: string,
    from: string,
    to: string,
    conceptId?: string
  ) {
    const context = { from, to, conceptId };
    super(message, 'CONVERSION_ERROR', ErrorCategory.CONVERSION, context);
  }
}

export class UnsupportedConversionError extends ConversionError {
  constructor(from: string, to: string) {
    super(
      `Conversion from ${from} to ${to} is not supported`,
      from,
      to
    );
  }
}

// Configuration errors
export class ConfigurationError extends PoliticianError {
  constructor(message: string, setting?: string, value?: unknown) {
    const context = setting ? { setting, value } : undefined;
    super(message, 'CONFIG_ERROR', ErrorCategory.CONFIGURATION, context);
  }
}

export class EnvironmentError extends ConfigurationError {
  constructor(variable: string, expected?: string) {
    const message = expected 
      ? `Environment variable ${variable} must be ${expected}`
      : `Missing required environment variable: ${variable}`;
    super(message, variable);
  }
}

// System errors
export class SystemError extends PoliticianError {
  constructor(message: string, component?: string, context?: Record<string, unknown>) {
    const errorContext = component ? { component, ...context } : context;
    super(message, 'SYSTEM_ERROR', ErrorCategory.SYSTEM, errorContext);
  }
}

export class MemoryError extends SystemError {
  constructor(operation: string, required: number, available?: number) {
    const context = { operation, required, available };
    super(
      `Insufficient memory for ${operation}: required ${required} bytes`,
      'memory',
      context
    );
  }
}

// Utility functions for error handling
export class ErrorHandler {
  /**
   * Convert any error to a PoliticianError
   */
  static normalize(error: unknown): PoliticianError {
    if (error instanceof PoliticianError) {
      return error;
    }

    if (error instanceof Error) {
      // Try to categorize common error types
      if (error.message.includes('timeout')) {
        return new TimeoutError('unknown', 0);
      }
      if (error.message.includes('not found')) {
        return new NotFoundError('resource', 'unknown');
      }
      if (error.message.includes('duplicate') || error.message.includes('already exists')) {
        return new DuplicateError('resource', 'unknown');
      }

      // Default to system error
      return new SystemError(error.message, 'unknown', { originalError: error });
    }

    // Handle primitive errors
    return new SystemError(String(error), 'unknown', { originalError: error });
  }

  /**
   * Check if an error is retryable
   */
  static isRetryable(error: PoliticianError): boolean {
    return (
      error.category === ErrorCategory.NETWORK ||
      error.category === ErrorCategory.ML_SERVICE ||
      (error.category === ErrorCategory.DATABASE && error.code === 'DATABASE_ERROR')
    );
  }

  /**
   * Get user-friendly error message
   */
  static getUserMessage(error: PoliticianError): string {
    switch (error.category) {
      case ErrorCategory.VALIDATION:
        return `Invalid input: ${error.message}`;
      case ErrorCategory.NOT_FOUND:
        return error.message;
      case ErrorCategory.PERMISSION:
        return `Access denied: ${error.message}`;
      case ErrorCategory.NETWORK:
        return 'Network error. Please check your connection and try again.';
      case ErrorCategory.ML_SERVICE:
        return 'AI service temporarily unavailable. Please try again later.';
      case ErrorCategory.DATABASE:
        return 'Data storage error. Please try again.';
      case ErrorCategory.CONFIGURATION:
        return 'System configuration error. Please contact support.';
      default:
        return 'An unexpected error occurred. Please try again.';
    }
  }
}

// Error logging utility
export function logError(error: PoliticianError, context?: Record<string, unknown>): void {
  const errorDetails = error.getDetails();
  const logData = {
    ...errorDetails,
    additionalContext: context,
    timestamp: new Date().toISOString(),
  };

  console.error(`[${error.category}] ${error.code}: ${error.message}`);
  if (process.env.NODE_ENV === 'development') {
    console.error('Error details:', JSON.stringify(logData, null, 2));
  }
}