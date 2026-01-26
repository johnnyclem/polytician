/**
 * Performance Monitoring and Metrics System
 *
 * Provides comprehensive monitoring for performance, health, and usage metrics
 * across the Politician MCP server and its components.
 */

export interface PerformanceMetrics {
  timestamp: number;
  operation: string;
  duration: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemMetrics {
  timestamp: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu: {
    usage: number;
    loadAverage: number[];
  };
  disk: {
    used: number;
    total: number;
    percentage: number;
  };
}

export interface APIMetrics {
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  requestSize: number;
  responseSize: number;
  timestamp: number;
  success: boolean;
}

export interface DatabaseMetrics {
  operation: string;
  table: string;
  duration: number;
  rowsAffected: number;
  timestamp: number;
  success: boolean;
}

export interface HealthMetrics {
  service: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  lastCheck: number;
  responseTime: number;
  details?: Record<string, unknown>;
}

/**
 * Metrics Collector for gathering and storing performance data
 */
export class MetricsCollector {
  private performanceMetrics: PerformanceMetrics[] = [];
  private systemMetrics: SystemMetrics[] = [];
  private apiMetrics: APIMetrics[] = [];
  private databaseMetrics: DatabaseMetrics[] = [];
  private healthMetrics: Map<string, HealthMetrics> = new Map();
  
  private readonly maxMetricsRetention = 10000; // Keep last 10k metrics
  private readonly collectionInterval = 30000; // Collect every 30 seconds
  private metricsTimer?: NodeJS.Timeout;

  constructor() {
    this.startCollection();
  }

  /**
   * Record a performance metric
   */
  recordPerformance(metric: Omit<PerformanceMetrics, 'timestamp'>): void {
    const fullMetric: PerformanceMetrics = {
      ...metric,
      timestamp: Date.now(),
    };
    
    this.performanceMetrics.push(fullMetric);
    this.trimMetrics(this.performanceMetrics);
    
    // Log significant performance issues
    if (metric.duration > 5000) { // > 5 seconds
      console.warn(`Slow operation detected: ${metric.operation} took ${metric.duration}ms`);
    }
  }

  /**
   * Record a system metric
   */
  recordSystem(metric: Omit<SystemMetrics, 'timestamp'>): void {
    const fullMetric: SystemMetrics = {
      ...metric,
      timestamp: Date.now(),
    };
    
    this.systemMetrics.push(fullMetric);
    this.trimMetrics(this.systemMetrics);
  }

  /**
   * Record an API metric
   */
  recordAPI(metric: Omit<APIMetrics, 'timestamp'>): void {
    const fullMetric: APIMetrics = {
      ...metric,
      timestamp: Date.now(),
    };
    
    this.apiMetrics.push(fullMetric);
    this.trimMetrics(this.apiMetrics);
  }

  /**
   * Record a database metric
   */
  recordDatabase(metric: Omit<DatabaseMetrics, 'timestamp'>): void {
    const fullMetric: DatabaseMetrics = {
      ...metric,
      timestamp: Date.now(),
    };
    
    this.databaseMetrics.push(fullMetric);
    this.trimMetrics(this.databaseMetrics);
  }

  /**
   * Record a health metric
   */
  recordHealth(metric: HealthMetrics): void {
    this.healthMetrics.set(metric.service, metric);
  }

  /**
   * Get all metrics for a time range
   */
  getMetrics(startTime?: number, endTime?: number = Date.now()) {
    const filter = (metric: { timestamp: number }) => 
      (!startTime || metric.timestamp >= startTime) && metric.timestamp <= endTime;

    return {
      performance: this.performanceMetrics.filter(filter),
      system: this.systemMetrics.filter(filter),
      api: this.apiMetrics.filter(filter),
      database: this.databaseMetrics.filter(filter),
      health: Array.from(this.healthMetrics.values())
        .filter(metric => (!startTime || metric.timestamp >= startTime) && metric.timestamp <= endTime),
    };
  }

  /**
   * Get performance summary
   */
  getPerformanceSummary(timeRange?: { start?: number; end?: number }) {
    const metrics = this.getMetrics(timeRange?.start, timeRange?.end).performance;
    
    if (metrics.length === 0) {
      return { count: 0, avgDuration: 0, errorRate: 0 };
    }

    const successful = metrics.filter(m => m.success);
    const failed = metrics.filter(m => !m.success);
    const durations = metrics.map(m => m.duration);

    return {
      count: metrics.length,
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      errorRate: failed.length / metrics.length,
      throughput: metrics.length / ((timeRange?.end ?? Date.now()) - (timeRange?.start ?? metrics[0]?.timestamp ?? Date.now())) * 1000, // ops per second
    };
  }

  /**
   * Get health status summary
   */
  getHealthSummary(): {
    overall: 'healthy' | 'degraded' | 'unhealthy';
    services: Array<HealthMetrics>;
  } {
    const services = Array.from(this.healthMetrics.values());
    const now = Date.now();
    const recentThreshold = 5 * 60 * 1000; // 5 minutes

    const recentServices = services.filter(s => (now - s.lastCheck) < recentThreshold);
    
    if (recentServices.length === 0) {
      return { overall: 'unhealthy', services: [] };
    }

    const unhealthyServices = recentServices.filter(s => s.status === 'unhealthy');
    const degradedServices = recentServices.filter(s => s.status === 'degraded');

    let overall: 'healthy' | 'degraded' | 'unhealthy';
    if (unhealthyServices.length > 0) {
      overall = 'unhealthy';
    } else if (degradedServices.length > 0) {
      overall = 'degraded';
    } else {
      overall = 'healthy';
    }

    return { overall, services: recentServices };
  }

  /**
   * Get resource usage summary
   */
  getResourceSummary(): SystemMetrics | null {
    if (this.systemMetrics.length === 0) {
      return null;
    }

    const latest = this.systemMetrics[this.systemMetrics.length - 1];
    return latest;
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheusMetrics(): string {
    const lines: string[] = [];
    
    // Performance metrics
    const perfSummary = this.getPerformanceSummary();
    lines.push(
      `politician_performance_total ${this.performanceMetrics.length}`,
      `politician_performance_duration_ms ${perfSummary.avgDuration}`,
      `politician_performance_error_rate ${perfSummary.errorRate}`,
      `politician_performance_throughput ${perfSummary.throughput}`
    );

    // System metrics
    const systemSummary = this.getResourceSummary();
    if (systemSummary) {
      lines.push(
        `politician_memory_usage_bytes ${systemSummary.memory.used}`,
        `politician_memory_percentage ${systemSummary.memory.percentage}`,
        `politician_cpu_usage ${systemSummary.cpu.usage}`,
        `politician_disk_usage_bytes ${systemSummary.disk.used}`,
        `politician_disk_percentage ${systemSummary.disk.percentage}`
      );
    }

    // Health metrics
    const healthSummary = this.getHealthSummary();
    lines.push(
      `politician_health_status 1 # ${healthSummary.overall}`
    );

    return lines.join('\n');
  }

  /**
   * Start automatic metrics collection
   */
  private startCollection(): void {
    this.metricsTimer = setInterval(() => {
      this.collectSystemMetrics();
    }, this.collectionInterval);
  }

  /**
   * Collect system metrics
   */
  private collectSystemMetrics(): void {
    try {
      const memoryUsage = process.memoryUsage();
      const totalMemory = memoryUsage.heapTotal + memoryUsage.external;
      
      this.recordSystem({
        memory: {
          used: memoryUsage.heapUsed,
          total: totalMemory,
          percentage: (memoryUsage.heapUsed / totalMemory) * 100,
        },
        cpu: {
          usage: process.cpuUsage ? process.cpuUsage().user : 0,
          loadAverage: require('os').loadavg(),
        },
        disk: {
          // Simplified disk usage (would need more complex implementation for real usage)
          used: 0,
          total: 100,
          percentage: 0,
        },
      });
    } catch (error) {
      console.error('Failed to collect system metrics:', error);
    }
  }

  /**
   * Trim metrics array to prevent memory leaks
   */
  private trimMetrics<T extends { timestamp: number }>(metrics: T[]): void {
    if (metrics.length > this.maxMetricsRetention) {
      metrics.splice(0, metrics.length - this.maxMetricsRetention);
    }
  }

  /**
   * Stop metrics collection
   */
  stop(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
  }

  /**
   * Clear all metrics
   */
  reset(): void {
    this.performanceMetrics = [];
    this.systemMetrics = [];
    this.apiMetrics = [];
    this.databaseMetrics = [];
    this.healthMetrics.clear();
  }
}

/**
 * Performance monitoring decorator
 */
export function monitorPerformance(operation?: string) {
  return function <T extends (...args: any[]) => Promise<any>>(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value!;

    descriptor.value = async function (this: any, ...args: any[]): Promise<any> {
      const opName = operation || `${target.constructor.name}.${propertyKey}`;
      const startTime = Date.now();
      
      try {
        const result = await originalMethod.apply(this, args);
        metricsCollector.recordPerformance({
          operation: opName,
          duration: Date.now() - startTime,
          success: true,
          metadata: { args: args.length },
        });
        return result;
      } catch (error) {
        metricsCollector.recordPerformance({
          operation: opName,
          duration: Date.now() - startTime,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          metadata: { args: args.length },
        });
        throw error;
      }
    };

    return descriptor;
  };
}

// Global metrics collector instance
export const metricsCollector = new MetricsCollector();