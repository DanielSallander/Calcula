//! FILENAME: app/src/utils/logFilter.ts
// PURPOSE: Console log interceptor with category-based filtering.
// Reads config from app/log-filter.config.json via Tauri backend.
// Provides window.logFilter API for runtime control from devtools.

import { invoke } from "@tauri-apps/api/core";

interface LogFilterConfig {
  muted: string[];
  mutedBackendCategories: string[];
  mutedBackendLevels: string[];
}

const BRACKET_RE = /^\[([^\]]+)\]/;

// Original console methods (saved before patching)
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalInfo = console.info.bind(console);

// Muted frontend categories (lowercase for case-insensitive matching)
const mutedCategories = new Set<string>();

// All categories seen since app start (for discovery)
const seenCategories = new Set<string>();

// Backend filter state (mirrors what was sent to Rust)
let backendMutedCategories: string[] = [];
let backendMutedLevels: string[] = [];

function extractCategory(args: unknown[]): string | null {
  if (args.length === 0 || typeof args[0] !== "string") return null;
  const match = args[0].match(BRACKET_RE);
  return match ? match[1] : null;
}

function createInterceptor(original: (...args: unknown[]) => void) {
  return function (...args: unknown[]) {
    const category = extractCategory(args);
    if (category) {
      seenCategories.add(category);
      if (mutedCategories.has(category.toLowerCase())) {
        return;
      }
    }
    original(...args);
  };
}

function saveToLocalStorage(): void {
  const config: LogFilterConfig = {
    muted: Array.from(mutedCategories),
    mutedBackendCategories: backendMutedCategories,
    mutedBackendLevels: backendMutedLevels,
  };
  try {
    localStorage.setItem("calcula:logFilter:runtime", JSON.stringify(config));
  } catch {
    // Ignore storage errors
  }
}

function pushBackendFilter(): void {
  invoke("set_log_filter", {
    mutedCategories: backendMutedCategories,
    mutedLevels: backendMutedLevels,
  }).catch(() => {
    // Backend not ready yet, will be applied on reload
  });
}

/** Load config from the backend (reads log-filter.config.json) */
async function loadConfigFromBackend(): Promise<void> {
  try {
    const config = await invoke<LogFilterConfig>("get_log_filter_config");

    // Apply frontend muted categories
    mutedCategories.clear();
    for (const cat of config.muted) {
      mutedCategories.add(cat.toLowerCase());
    }

    // Store backend state
    backendMutedCategories = config.mutedBackendCategories;
    backendMutedLevels = config.mutedBackendLevels;

    originalLog(
      `[LogFilter] Config loaded: muting frontend=[${config.muted.join(", ")}] backend=[${config.mutedBackendCategories.join(", ")}] levels=[${config.mutedBackendLevels.join(", ")}]`
    );
  } catch (e) {
    originalLog("[LogFilter] Failed to load config from backend:", e);
  }
}

/** Runtime API exposed on window.logFilter */
const logFilterAPI = {
  mute(...categories: string[]) {
    for (const cat of categories) {
      mutedCategories.add(cat.toLowerCase());
    }
    saveToLocalStorage();
    originalLog(`[LogFilter] Muted: ${categories.join(", ")}`);
  },

  unmute(...categories: string[]) {
    for (const cat of categories) {
      mutedCategories.delete(cat.toLowerCase());
    }
    saveToLocalStorage();
    originalLog(`[LogFilter] Unmuted: ${categories.join(", ")}`);
  },

  toggle(category: string): boolean {
    const key = category.toLowerCase();
    if (mutedCategories.has(key)) {
      mutedCategories.delete(key);
      saveToLocalStorage();
      originalLog(`[LogFilter] Unmuted: ${category}`);
      return false;
    } else {
      mutedCategories.add(key);
      saveToLocalStorage();
      originalLog(`[LogFilter] Muted: ${category}`);
      return true;
    }
  },

  solo(...categories: string[]) {
    const keep = new Set(categories.map((c) => c.toLowerCase()));
    for (const seen of seenCategories) {
      if (!keep.has(seen.toLowerCase())) {
        mutedCategories.add(seen.toLowerCase());
      } else {
        mutedCategories.delete(seen.toLowerCase());
      }
    }
    saveToLocalStorage();
    originalLog(`[LogFilter] Solo mode: only showing [${categories.join(", ")}]`);
  },

  muteAll() {
    for (const cat of seenCategories) {
      mutedCategories.add(cat.toLowerCase());
    }
    saveToLocalStorage();
    originalLog("[LogFilter] All seen categories muted");
  },

  unmuteAll() {
    mutedCategories.clear();
    saveToLocalStorage();
    originalLog("[LogFilter] All categories unmuted");
  },

  status() {
    originalLog("[LogFilter] --- Status ---");
    originalLog(`  Frontend muted: ${mutedCategories.size === 0 ? "(none)" : Array.from(mutedCategories).join(", ")}`);
    originalLog(`  Backend muted categories: ${backendMutedCategories.length === 0 ? "(none)" : backendMutedCategories.join(", ")}`);
    originalLog(`  Backend muted levels: ${backendMutedLevels.length === 0 ? "(none)" : backendMutedLevels.join(", ")}`);
    originalLog(`  Seen categories: ${seenCategories.size === 0 ? "(none)" : Array.from(seenCategories).sort().join(", ")}`);
  },

  categories() {
    const sorted = Array.from(seenCategories).sort();
    originalLog(`[LogFilter] ${sorted.length} categories seen: ${sorted.join(", ")}`);
    return sorted;
  },

  muteBackend(...categories: string[]) {
    const set = new Set([...backendMutedCategories, ...categories]);
    backendMutedCategories = Array.from(set);
    pushBackendFilter();
    saveToLocalStorage();
    originalLog(`[LogFilter] Backend muted categories: ${backendMutedCategories.join(", ")}`);
  },

  unmuteBackend(...categories: string[]) {
    const remove = new Set(categories);
    backendMutedCategories = backendMutedCategories.filter((c) => !remove.has(c));
    pushBackendFilter();
    saveToLocalStorage();
    originalLog(`[LogFilter] Backend muted categories: ${backendMutedCategories.length === 0 ? "(none)" : backendMutedCategories.join(", ")}`);
  },

  muteBackendLevel(...levels: string[]) {
    const set = new Set([...backendMutedLevels, ...levels]);
    backendMutedLevels = Array.from(set);
    pushBackendFilter();
    saveToLocalStorage();
    originalLog(`[LogFilter] Backend muted levels: ${backendMutedLevels.join(", ")}`);
  },

  unmuteBackendLevel(...levels: string[]) {
    const remove = new Set(levels);
    backendMutedLevels = backendMutedLevels.filter((l) => !remove.has(l));
    pushBackendFilter();
    saveToLocalStorage();
    originalLog(`[LogFilter] Backend muted levels: ${backendMutedLevels.length === 0 ? "(none)" : backendMutedLevels.join(", ")}`);
  },

  async reload() {
    await loadConfigFromBackend();
    originalLog("[LogFilter] Config reloaded from file");
  },

  reset() {
    mutedCategories.clear();
    backendMutedCategories = [];
    backendMutedLevels = [];
    pushBackendFilter();
    saveToLocalStorage();
    originalLog("[LogFilter] All filters reset");
  },
};

declare global {
  interface Window {
    logFilter: typeof logFilterAPI;
  }
}

/**
 * Install the log filter interceptor. Call this as early as possible in main.tsx.
 * Patches console.log/warn/info immediately (synchronous).
 * Loads config from backend asynchronously.
 */
export function installLogFilter(): void {
  // Patch console methods
  console.log = createInterceptor(originalLog) as typeof console.log;
  console.warn = createInterceptor(originalWarn) as typeof console.warn;
  console.info = createInterceptor(originalInfo) as typeof console.info;
  // console.error is intentionally NOT patched — errors should always be visible

  // Expose runtime API
  window.logFilter = logFilterAPI;

  // Load config from backend (async — interceptor is already in place)
  loadConfigFromBackend();

  originalLog("[LogFilter] Installed. Use logFilter.status() for info, logFilter.categories() to see seen categories.");
}
