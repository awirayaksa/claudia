/**
 * Renderer Process Logger Service
 *
 * Centralized logging system for the renderer process with:
 * - Structured JSON logging
 * - Request tracing with correlation IDs
 * - Console output (development)
 * - File output via IPC (production)
 * - Configurable log levels
 */

import {
  LogLevel,
  LogEntry,
  LoggerConfig,
  RequestTracer,
  LOG_LEVEL_PRIORITY,
  DEFAULT_LOGGER_CONFIG,
} from '../types/logger.types';

/**
 * Centralized Logger for Renderer Process
 */
export class Logger {
  private static config: LoggerConfig = DEFAULT_LOGGER_CONFIG;
  private static isInitialized = false;

  /**
   * Initialize the logger with configuration
   * @param config Logger configuration options
   */
  static initialize(config: Partial<LoggerConfig>): void {
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };
    this.isInitialized = true;

    this.info('logger', 'Logger initialized', {
      logLevel: this.config.logLevel,
      enableFileLogging: this.config.enableFileLogging,
      enableConsoleLogging: this.config.enableConsoleLogging,
    });
  }

  /**
   * Update logger configuration at runtime
   * @param config Partial configuration to update
   */
  static updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    this.info('logger', 'Logger configuration updated', config);
  }

  /**
   * Generate a unique trace ID (UUID v4)
   * @returns UUID v4 string
   */
  static generateTraceId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Core logging method
   * @param level Log level
   * @param module Module/component identifier
   * @param message Log message
   * @param data Optional structured data
   * @param traceId Optional trace ID for correlation
   */
  static log(
    level: LogLevel,
    module: string,
    message: string,
    data?: Record<string, unknown>,
    traceId?: string
  ): void {
    // Filter based on configured log level
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.logLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      traceId: traceId || this.generateTraceId(),
      process: 'renderer',
      module,
      level,
      message,
      data,
    };

    // Output to console
    if (this.config.enableConsoleLogging !== false) {
      this.logToConsole(entry);
    }

    // Send to main process for file logging
    if (this.config.enableFileLogging && window.electron?.logger?.write) {
      window.electron.logger.write(entry);
    }
  }

  /**
   * Log debug message
   * @param module Module identifier
   * @param message Log message
   * @param data Optional data
   * @param traceId Optional trace ID
   */
  static debug(
    module: string,
    message: string,
    data?: Record<string, unknown>,
    traceId?: string
  ): void {
    this.log('debug', module, message, data, traceId);
  }

  /**
   * Log info message
   * @param module Module identifier
   * @param message Log message
   * @param data Optional data
   * @param traceId Optional trace ID
   */
  static info(
    module: string,
    message: string,
    data?: Record<string, unknown>,
    traceId?: string
  ): void {
    this.log('info', module, message, data, traceId);
  }

  /**
   * Log warning message
   * @param module Module identifier
   * @param message Log message
   * @param data Optional data
   * @param traceId Optional trace ID
   */
  static warn(
    module: string,
    message: string,
    data?: Record<string, unknown>,
    traceId?: string
  ): void {
    this.log('warn', module, message, data, traceId);
  }

  /**
   * Log error message
   * @param module Module identifier
   * @param message Log message
   * @param error Optional error object
   * @param data Optional additional data
   * @param traceId Optional trace ID
   */
  static error(
    module: string,
    message: string,
    error?: Error,
    data?: Record<string, unknown>,
    traceId?: string
  ): void {
    const errorData = error
      ? {
          error: {
            message: error.message,
            stack: error.stack,
            code: (error as any).code,
          },
        }
      : undefined;

    this.log('error', module, message, { ...data, ...errorData }, traceId);
  }

  /**
   * Create a request tracer for tracking operations
   * @param module Module identifier
   * @param operation Operation name
   * @returns RequestTracer instance
   */
  static trace(module: string, operation: string): RequestTracer {
    const traceId = this.generateTraceId();
    const startTime = Date.now();

    this.info(module, `Started: ${operation}`, { operation }, traceId);

    return {
      traceId,
      module,
      operation,
      startTime,

      checkpoint(message: string, data?: Record<string, unknown>): void {
        Logger.info(module, `[${operation}] ${message}`, data, traceId);
      },

      complete(message: string, data?: Record<string, unknown>): void {
        const duration = Date.now() - startTime;
        Logger.info(
          module,
          `Completed: ${operation} - ${message}`,
          { ...data, duration, operation },
          traceId
        );
      },

      error(message: string, error: Error, data?: Record<string, unknown>): void {
        const duration = Date.now() - startTime;
        Logger.error(
          module,
          `Failed: ${operation} - ${message}`,
          error,
          { ...data, duration, operation },
          traceId
        );
      },
    };
  }

  /**
   * Format and output log entry to console
   * @param entry Log entry
   */
  private static logToConsole(entry: LogEntry): void {
    // Color coding for different log levels
    const colors = {
      debug: 'color: #888; font-weight: normal;',
      info: 'color: #0066cc; font-weight: bold;',
      warn: 'color: #ff9900; font-weight: bold;',
      error: 'color: #cc0000; font-weight: bold;',
    };

    const style = colors[entry.level];
    const traceIdShort = entry.traceId.substring(0, 8);

    // Format: [timestamp] [traceId] [module] [level] message
    const prefix = `[${entry.timestamp}] [${traceIdShort}] [${entry.module}] [${entry.level.toUpperCase()}]`;

    // Use appropriate console method
    const consoleMethod = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';

    if (entry.data) {
      console[consoleMethod](`%c${prefix} ${entry.message}`, style, entry.data);
    } else {
      console[consoleMethod](`%c${prefix} ${entry.message}`, style);
    }

    // Show error stack if present
    if (entry.error?.stack) {
      console.error('Stack trace:', entry.error.stack);
    }
  }
}

// Auto-initialize with defaults if not already initialized
if (!Logger['isInitialized']) {
  Logger.initialize({});
}
