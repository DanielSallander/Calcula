//! FILENAME: app/src-tauri/src/utils/bridge.ts
// PURPOSE: Wrapper around Tauri's invoke function with compact AI-optimized logging.
// FORMAT: [timestamp]|level|category|message (e.g., "[2025-01-15 10:30:45.123]|I|CMD|update_cell r=0 c=0")

import { invoke } from '@tauri-apps/api/core';

type InvokeArgs = Record<string, unknown>;

// Level codes: I=INFO, D=DEBUG, E=ERROR, W=WARN
type LogLevel = 'I' | 'D' | 'E' | 'W';

/**
 * Get formatted timestamp: [YYYY-MM-DD HH:mm:ss.SSS]
 */
function getTimestamp(): string {
    const now = new Date();
    const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
    
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const ms = pad(now.getMilliseconds(), 3);
    
    return `[${date} ${time}.${ms}]`;
}

/**
 * Send a compact log line to the backend.
 * Format: [timestamp]|level|category|message
 */
async function log(level: LogLevel, category: string, message: string): Promise<void> {
    const line = `${getTimestamp()}|${level}|${category}|${message}`;
    
    // Fire and forget
    invoke('log_frontend', { level, message: line }).catch(() => {});
}

/**
 * Compact argument serializer - strips quotes and braces for common cases.
 */
function compactArgs(args: InvokeArgs): string {
    if (Object.keys(args).length === 0) return '';
    
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        
        // Shorten common key names
        const shortKey = key
            .replace('start_row', 'sr')
            .replace('end_row', 'er')
            .replace('start_col', 'sc')
            .replace('end_col', 'ec')
            .replace('row', 'r')
            .replace('col', 'c')
            .replace('input', 'in')
            .replace('style_index', 'si');
        
        if (typeof value === 'object') {
            parts.push(`${shortKey}=${JSON.stringify(value)}`);
        } else {
            parts.push(`${shortKey}=${value}`);
        }
    }
    
    return parts.join(' ');
}

/**
 * A wrapper around the standard Tauri invoke function.
 * Logs commands in compact format for AI consumption.
 */
export async function tracedInvoke<T>(cmd: string, args: InvokeArgs = {}): Promise<T> {
    const startTime = performance.now();

    // Don't trace the log command itself
    if (cmd === 'log_frontend') {
        return invoke<T>(cmd, args);
    }

    const argsStr = compactArgs(args);
    
    // Console output (for dev)
    console.groupCollapsed(`[Bridge] ${cmd}`);
    console.log('Args:', args);

    try {
        const result = await invoke<T>(cmd, args);
        const ms = Math.round(performance.now() - startTime);

        console.log(`OK ${ms}ms`, result);
        console.groupEnd();

        // Compact log: [timestamp]|I|CMD|command_name args ms=duration
        await log('I', 'CMD', `${cmd} ${argsStr} ms=${ms}`);

        return result;

    } catch (error) {
        const ms = Math.round(performance.now() - startTime);
        
        console.error(`FAIL ${ms}ms`, error);
        console.groupEnd();

        const errStr = error instanceof Error ? error.message : String(error);
        await log('E', 'CMD', `${cmd} ${argsStr} ms=${ms} err=${errStr}`);

        throw error;
    }
}

/**
 * Log a user action (click, input, etc.)
 */
export async function logUserAction(action: string, target: string, detail?: string): Promise<void> {
    const msg = detail ? `${action} <${target}> ${detail}` : `${action} <${target}>`;
    await log('I', 'USER', msg);
}

/**
 * Log a system event
 */
export async function logSystem(message: string, level: LogLevel = 'I'): Promise<void> {
    await log(level, 'SYS', message);
}

/**
 * Log debug info
 */
export async function logDebug(message: string): Promise<void> {
    await log('D', 'DBG', message);
}

/**
 * Manually trigger a log file sort on the backend
 */
export async function sortLogs(): Promise<string> {
    return tracedInvoke('sort_log_file');
}