/**
 * Main Process Logger Service
 *
 * Centralized logging system for the main process with:
 * - File writing with daily rotation
 * - Log file cleanup based on retention policy
 * - IPC forwarding to renderer for console display
 * - Same API as renderer logger for consistency
 */

import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';

/**
 * Type definitions (mirrored from renderer)
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ProcessType = 'renderer' | 'main';

export interface LogEntry {
  timestamp: string;
  traceId: string;
  process: ProcessType;
  module: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
  duration?: number;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

export interface LoggerConfig {
  logLevel: LogLevel;
  enableFileLogging: boolean;
  logDirectory?: string;
  enableConsoleLogging?: boolean;
  maxFileSizeMB?: number;
  retentionDays?: number;
}

export interface RequestTracer {
  traceId: string;
  module: string;
  operation: string;
  startTime: number;
  checkpoint(message: string, data?: Record<string, unknown>): void;
  complete(message: string, data?: Record<string, unknown>): void;
  error(message: string, error: Error, data?: Record<string, unknown>): void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  logLevel: 'info',
  enableFileLogging: true,
  enableConsoleLogging: true,
  maxFileSizeMB: 50,
  retentionDays: 7,
};

/**
 * Centralized Logger for Main Process
 */
export class LoggerService {
  private static config: LoggerConfig = DEFAULT_LOGGER_CONFIG;
  private static isInitialized = false;
  private static currentLogFile: string | null = null;
  private static logDirectory: string | null = null;

  /**
   * Initialize the logger with configuration
   * @param config Logger configuration options
   */
  static initialize(config: Partial<LoggerConfig>): void {
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };

    // Set up log directory
    if (this.config.enableFileLogging) {
      this.logDirectory = config.logDirectory || path.join(app.getPath('userData'), 'logs');
      this.ensureLogDirectory();
      this.cleanupOldLogs();
    }

    this.isInitialized = true;

    this.info('logger', 'Main process logger initialized', {
      logLevel: this.config.logLevel,
      enableFileLogging: this.config.enableFileLogging,
      logDirectory: this.logDirectory,
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
      process: 'main',
      module,
      level,
      message,
      data,
    };

    // Output to console
    if (this.config.enableConsoleLogging !== false) {
      this.logToConsole(entry);
    }

    // Write to file
    if (this.config.enableFileLogging) {
      this.writeToFile(entry);
    }

    // Forward to renderer for display (if window exists)
    this.forwardToRenderer(entry);
  }

  /**
   * Log debug message
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
        LoggerService.info(module, `[${operation}] ${message}`, data, traceId);
      },

      complete(message: string, data?: Record<string, unknown>): void {
        const duration = Date.now() - startTime;
        LoggerService.info(
          module,
          `Completed: ${operation} - ${message}`,
          { ...data, duration, operation },
          traceId
        );
      },

      error(message: string, error: Error, data?: Record<string, unknown>): void {
        const duration = Date.now() - startTime;
        LoggerService.error(
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
   * Write log entry from renderer process (called via IPC)
   */
  static writeFromRenderer(entry: LogEntry): void {
    if (this.config.enableFileLogging) {
      this.writeToFile(entry);
    }
  }

  /**
   * Ensure log directory exists
   */
  private static ensureLogDirectory(): void {
    if (!this.logDirectory) return;

    try {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  /**
   * Get current log file path
   */
  private static getCurrentLogFile(): string {
    if (!this.logDirectory) {
      throw new Error('Log directory not initialized');
    }

    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logDirectory, `claudia-${date}.log`);
  }

  /**
   * Write log entry to file
   */
  private static writeToFile(entry: LogEntry): void {
    try {
      const logFile = this.getCurrentLogFile();

      // Check file size and rotate if needed
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB >= (this.config.maxFileSizeMB || 50)) {
          this.rotateLogFile(logFile);
        }
      }

      // Append log entry as JSON line
      const logLine = JSON.stringify(entry) + '\n';
      fs.appendFileSync(logFile, logLine, 'utf8');

      this.currentLogFile = logFile;
    } catch (error) {
      console.error('Failed to write log to file:', error);
    }
  }

  /**
   * Rotate log file when size limit is reached
   */
  private static rotateLogFile(logFile: string): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = path.extname(logFile);
      const base = logFile.slice(0, -ext.length);
      const rotatedFile = `${base}-${timestamp}${ext}`;

      fs.renameSync(logFile, rotatedFile);
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  /**
   * Clean up old log files based on retention policy
   */
  private static cleanupOldLogs(): void {
    if (!this.logDirectory) return;

    try {
      const retentionMs = (this.config.retentionDays || 7) * 24 * 60 * 60 * 1000;
      const now = Date.now();

      const files = fs.readdirSync(this.logDirectory);

      for (const file of files) {
        if (!file.startsWith('claudia-') || !file.endsWith('.log')) {
          continue;
        }

        const filePath = path.join(this.logDirectory, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > retentionMs) {
          fs.unlinkSync(filePath);
          console.log(`Deleted old log file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
    }
  }

  /**
   * Format and output log entry to console
   */
  private static logToConsole(entry: LogEntry): void {
    const traceIdShort = entry.traceId.substring(0, 8);
    const prefix = `[${entry.timestamp}] [${traceIdShort}] [${entry.module}] [${entry.level.toUpperCase()}]`;

    const consoleMethod = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';

    if (entry.data) {
      console[consoleMethod](`${prefix} ${entry.message}`, entry.data);
    } else {
      console[consoleMethod](`${prefix} ${entry.message}`);
    }

    if (entry.error?.stack) {
      console.error('Stack trace:', entry.error.stack);
    }
  }

  /**
   * Forward log entry to renderer process for console display
   */
  private static forwardToRenderer(entry: LogEntry): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send('logger:entry', entry);
      }
    } catch (error) {
      // Silently fail if renderer is not ready
    }
  }

  /**
   * Get log directory path
   */
  static getLogDirectory(): string | null {
    return this.logDirectory;
  }

  /**
   * Get all log files
   */
  static getLogFiles(): string[] {
    if (!this.logDirectory) return [];

    try {
      const files = fs.readdirSync(this.logDirectory);
      return files
        .filter(file => file.startsWith('claudia-') && file.endsWith('.log'))
        .map(file => path.join(this.logDirectory!, file));
    } catch (error) {
      console.error('Failed to get log files:', error);
      return [];
    }
  }
}
