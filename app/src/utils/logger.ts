//! FILENAME: app/src/utils/logger.ts
// PURPOSE: Centralized logging with atomic sequence assignment from backend
// FORMAT: seq|level|category|message

import { invoke } from "@tauri-apps/api/core";

type LogLevel = "D" | "I" | "W" | "E";
type LogLevelFull = "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";

const LEVEL_MAP: Record<LogLevelFull, LogLevel | "NONE"> = {
  DEBUG: "D",
  INFO: "I",
  WARN: "W",
  ERROR: "E",
  NONE: "NONE"
};

const LEVEL_PRIORITY: Record<LogLevel | "NONE", number> = {
  D: 0,
  I: 1,
  W: 2,
  E: 3,
  NONE: 4
};

class Logger {
  private level: LogLevel | "NONE";
  private enabled: boolean;
  private useFile: boolean;

  constructor() {
    this.enabled = import.meta.env.DEV;
    this.level = "D";
    this.useFile = true;
  }

  setLevel(level: LogLevelFull): void {
    this.level = LEVEL_MAP[level];
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  setFileLogging(useFile: boolean): void {
    this.useFile = useFile;
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) return false;
    if (this.level === "NONE") return false;
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  /**
   * Write log atomically - backend assigns seq and writes in one operation
   */
  private async writeLog(level: LogLevel, category: string, message: string, data?: unknown): Promise<void> {
    let fullMessage = message;
    if (data !== undefined && data !== null) {
      const dataStr = typeof data === 'object' ? JSON.stringify(data) : String(data);
      fullMessage += ` ${dataStr}`;
    }

    if (this.useFile) {
      try {
        // Single atomic call - backend assigns seq and writes together
        await invoke("log_frontend_atomic", { 
          level, 
          category, 
          message: fullMessage 
        });
      } catch (error) {
        // Fallback to console
        console.error("Log write failed:", error);
        console.log(`[${level}][${category}] ${fullMessage}`);
      }
    } else {
      const consoleMethod = level === "E" ? console.error :
                            level === "W" ? console.warn :
                            level === "I" ? console.info :
                            console.log;
      consoleMethod(`[${level}][${category}] ${fullMessage}`);
    }
  }

  debug(category: string, message: string, data?: unknown): void {
    if (this.shouldLog("D")) {
      this.writeLog("D", category, message, data);
    }
  }

  info(category: string, message: string, data?: unknown): void {
    if (this.shouldLog("I")) {
      this.writeLog("I", category, message, data);
    }
  }

  warn(category: string, message: string, data?: unknown): void {
    if (this.shouldLog("W")) {
      this.writeLog("W", category, message, data);
    }
  }

  error(category: string, message: string, data?: unknown): void {
    if (this.shouldLog("E")) {
      this.writeLog("E", category, message, data);
    }
  }

  traceAPI(method: string, params: Record<string, unknown>, result?: unknown, error?: unknown): void {
    if (this.shouldLog("D")) {
      let msg = `${method} params=${JSON.stringify(params)}`;
      if (result !== undefined) msg += ` result=${JSON.stringify(result)}`;
      if (error !== undefined) msg += ` err=${JSON.stringify(error)}`;
      this.writeLog("D", "API", msg);
    }
  }
}

export const logger = new Logger();

export const debug = (cat: string, msg: string, data?: unknown): void => logger.debug(cat, msg, data);
export const info = (cat: string, msg: string, data?: unknown): void => logger.info(cat, msg, data);
export const warn = (cat: string, msg: string, data?: unknown): void => logger.warn(cat, msg, data);
export const error = (cat: string, msg: string, data?: unknown): void => logger.error(cat, msg, data);

// Moved from log.ts to consolidate
export function logObject(cat: string, label: string, obj: unknown): void {
  logger.debug(cat, label, obj);
}