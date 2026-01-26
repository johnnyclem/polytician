/**
 * Circuit Breaker Implementation
 *
 * Provides fault tolerance for external service calls by automatically
 * failing fast when a service is experiencing repeated failures.
 */

export interface CircuitBreakerOptions {
  // Number of failures before opening circuit
  failureThreshold?: number;
  
  // Time window for failure counting (milliseconds)
  timeoutDuration?: number;
  
  // Time to wait before trying again (milliseconds)
  resetTimeout?: number;
  
  // Function to determine if error counts as failure
  errorFilter?: (error: unknown) => boolean;
  
  // Callbacks for state changes
  onOpen?: () => void;
  onHalfOpen?: () => void;
  onClose?: () => void;
}

export enum CircuitState {
  CLOSED = 'CLOSED',    // Normal operation
  OPEN = 'OPEN',        // Circuit is open, calls fail fast
  HALF_OPEN = 'HALF_OPEN' // Testing if service has recovered
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime?: number;
  nextAttemptTime?: number;
}

/**
 * Circuit Breaker class for protecting against cascading failures
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime?: number;
  private nextAttemptTime?: number;
  
  private readonly failureThreshold: number;
  private readonly timeoutDuration: number;
  private readonly resetTimeout: number;
  private readonly errorFilter: (error: unknown) => boolean;
  private readonly callbacks: {
    onOpen?: () => void;
    onHalfOpen?: () => void;
    onClose?: () => void;
  };

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.timeoutDuration = options.timeoutDuration ?? 60000;  // 1 minute
    this.resetTimeout = options.resetTimeout ?? 30000;     // 30 seconds
    this.errorFilter = options.errorFilter ?? this.defaultErrorFilter;
    this.callbacks = {
      onOpen: options.onOpen,
      onHalfOpen: options.onHalfOpen,
      onClose: options.onClose,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < (this.nextAttemptTime ?? 0)) {
        throw new CircuitBreakerOpenError(
          'Circuit breaker is OPEN',
          this.getStats()
        );
      }
      this.transitionToHalfOpen();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.errorFilter(error)) {
        this.onFailure();
      }
      throw error;
    }
  }

  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  /**
   * Force the circuit breaker to open
   */
  open(): void {
    this.transitionToOpen();
  }

  /**
   * Force the circuit breaker to close
   */
  close(): void {
    this.transitionToClosed();
  }

  /**
   * Reset all statistics and close circuit
   */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = undefined;
    this.nextAttemptTime = undefined;
    this.transitionToClosed();
  }

  /**
   * Handle successful operation
   */
  private onSuccess(): void {
    this.successes++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionToClosed();
    }
  }

  /**
   * Handle failed operation
   */
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    switch (this.state) {
      case CircuitState.CLOSED:
        if (this.failures >= this.failureThreshold) {
          this.transitionToOpen();
        }
        break;
      
      case CircuitState.HALF_OPEN:
        this.transitionToOpen();
        break;
    }
  }

  /**
   * Transition to OPEN state
   */
  private transitionToOpen(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.resetTimeout;
    this.callbacks.onOpen?.();
  }

  /**
   * Transition to HALF_OPEN state
   */
  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.callbacks.onHalfOpen?.();
  }

  /**
   * Transition to CLOSED state
   */
  private transitionToClosed(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.nextAttemptTime = undefined;
    this.callbacks.onClose?.();
  }

  /**
   * Default error filter - counts network and timeout errors as failures
   */
  private defaultErrorFilter(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('connection') ||
        message.includes('econnrefused') ||
        message.includes('fetch')
      );
    }
    return false;
  }
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string, public readonly stats: CircuitBreakerStats) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Decorator for adding circuit breaker to methods
 */
export function withCircuitBreaker(options: CircuitBreakerOptions = {}) {
  const circuitBreaker = new CircuitBreaker(options);
  
  return function <T extends (...args: any[]) => Promise<any>, R>(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value!;

    descriptor.value = async function (this: any, ...args: any[]): Promise<R> {
      return circuitBreaker.execute(() => originalMethod.apply(this, args));
    };

    // Expose circuit breaker for external access
    (descriptor as any).circuitBreaker = circuitBreaker;
    
    return descriptor;
  };
}

/**
 * Manager for multiple circuit breakers
 */
export class CircuitBreakerManager {
  private readonly breakers = new Map<string, CircuitBreaker>();

  /**
   * Get or create a circuit breaker for a service
   */
  getBreaker(name: string, options: CircuitBreakerOptions = {}): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(options));
    }
    return this.breakers.get(name)!;
  }

  /**
   * Get statistics for all circuit breakers
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Close all circuit breakers
   */
  closeAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.close();
    }
  }

  /**
   * Get names of all open circuit breakers
   */
  getOpenBreakers(): string[] {
    const open: string[] = [];
    for (const [name, breaker] of this.breakers) {
      if (breaker.getStats().state === CircuitState.OPEN) {
        open.push(name);
      }
    }
    return open;
  }
}

// Global circuit breaker manager instance
export const circuitBreakerManager = new CircuitBreakerManager();