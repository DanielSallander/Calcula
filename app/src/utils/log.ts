//! FILENAME: app/src/utils/log.ts
// PURPOSE: Simple wrapper around logger for easy importing

import { logger as loggerInstance } from './logger';

export const logger = loggerInstance;

export function debug(cat: string, msg: string, data?: unknown): void {
  loggerInstance.debug(cat, msg, data);
}

export function info(cat: string, msg: string, data?: unknown): void {
  loggerInstance.info(cat, msg, data);
}

export function warn(cat: string, msg: string, data?: unknown): void {
  loggerInstance.warn(cat, msg, data);
}

export function error(cat: string, msg: string, data?: unknown): void {
  loggerInstance.error(cat, msg, data);
}

export function logObject(cat: string, label: string, obj: unknown): void {
  loggerInstance.debug(cat, label, obj);
}
