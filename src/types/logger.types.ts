/**
 * Logger Type Definitions
 *
 * Comprehensive type system for unified request tracing and logging
 * across Electron main and renderer processes.
 */

/**
 * Log level enumeration
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Process type indicator
 */
export type ProcessType = 'renderer' | 'main';

/**
 * Core log entry structure
 * This is the fundamental unit of logging, written to both console and files.
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;

  /** Unique trace ID (UUID v4) for correlating related logs */
  traceId: string;

  /** Which Electron process generated this log */
  process: ProcessType;

  /** Module/component identifier (e.g., "chat.stream", "mcp.tool", "api.openrouter") */
  module: string;

  /** Log severity level */
  level: LogLevel;

  /** Human-readable message */
  message: string;

  /** Optional structured data (must be JSON-serializable) */
  data?: Record<string, unknown>;

  /** Operation duration in milliseconds (for traced operations) */
  duration?: number;

  /** Error details (if this is an error log) */
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

/**
 * Configuration options for Logger initialization
 */
export interface LoggerConfig {
  /** Minimum log level to output (logs below this are filtered) */
  logLevel: LogLevel;

  /** Whether to write logs to files */
  enableFileLogging: boolean;

  /** Directory path for log files (only used if enableFileLogging is true) */
  logDirectory?: string;

  /** Whether to output logs to console */
  enableConsoleLogging?: boolean;

  /** Maximum size per log file in MB before rotation */
  maxFileSizeMB?: number;

  /** Number of days to keep log files */
  retentionDays?: number;
}

/**
 * Request tracer for tracking operations from start to completion
 *
 * Example usage:
 * ```typescript
 * const tracer = Logger.trace('chat.stream', 'llm_conversation');
 * tracer.checkpoint('Started LLM request');
 * // ... do work ...
 * tracer.complete('Conversation complete', { iterations: 3 });
 * ```
 */
export interface RequestTracer {
  /** Unique trace ID for this operation */
  traceId: string;

  /** Module identifier */
  module: string;

  /** Operation name */
  operation: string;

  /** Start timestamp (milliseconds since epoch) */
  startTime: number;

  /**
   * Log a checkpoint in the operation
   * @param message Checkpoint description
   * @param data Optional structured data
   */
  checkpoint(message: string, data?: Record<string, unknown>): void;

  /**
   * Mark operation as successfully completed
   * @param message Completion message
   * @param data Optional structured data (will include duration)
   */
  complete(message: string, data?: Record<string, unknown>): void;

  /**
   * Mark operation as failed
   * @param message Error description
   * @param error Error object
   * @param data Optional additional context
   */
  error(message: string, error: Error, data?: Record<string, unknown>): void;
}

/**
 * Log file metadata
 */
export interface LogFileInfo {
  /** Full path to log file */
  filePath: string;

  /** File size in bytes */
  size: number;

  /** Creation timestamp */
  created: Date;

  /** Last modified timestamp */
  modified: Date;
}

/**
 * Log level hierarchy for filtering
 * Lower number = more verbose
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Default logger configuration
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  logLevel: 'info',
  enableFileLogging: true,
  enableConsoleLogging: true,
  maxFileSizeMB: 50,
  retentionDays: 7,
};
