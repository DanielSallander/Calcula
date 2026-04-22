//! FILENAME: app/extensions/AutoRecover/index.ts
// PURPOSE: AutoRecover extension - saves the workbook at regular intervals to
//          prevent data loss.
// CONTEXT: Runs a background timer that calls auto_recover_save when the file
//          is dirty. Settings are persisted in AppState on the Rust side.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerMenuItem } from "@api";
import { invokeBackend } from "@api/backend";

// ============================================================================
// Types
// ============================================================================

interface AutoRecoverSettings {
  enabled: boolean;
  intervalMs: number;
}

// ============================================================================
// Backend API Helpers
// ============================================================================

async function getAutoRecoverSettings(): Promise<AutoRecoverSettings> {
  return invokeBackend<AutoRecoverSettings>("get_auto_recover_settings");
}

async function setAutoRecoverSettingsBackend(
  enabled: boolean,
  intervalMs: number,
): Promise<AutoRecoverSettings> {
  return invokeBackend<AutoRecoverSettings>("set_auto_recover_settings", {
    enabled,
    intervalMs,
  });
}

async function autoRecoverSave(): Promise<string> {
  return invokeBackend<string>("auto_recover_save");
}

// ============================================================================
// State
// ============================================================================

let timerId: ReturnType<typeof setInterval> | null = null;
let currentEnabled = true;
let currentIntervalMs = 300_000; // 5 minutes

// ============================================================================
// Timer Management
// ============================================================================

function stopTimer(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

function startTimer(): void {
  stopTimer();
  if (!currentEnabled || currentIntervalMs <= 0) return;

  timerId = setInterval(async () => {
    try {
      await autoRecoverSave();
    } catch {
      // "not_dirty" is expected when no changes have been made -- ignore it.
      // Other errors (disk full, etc.) are silently swallowed for background saves.
    }
  }, currentIntervalMs);
}

async function loadSettings(): Promise<void> {
  const settings = await getAutoRecoverSettings();
  currentEnabled = settings.enabled;
  currentIntervalMs = settings.intervalMs;
}

// ============================================================================
// Interval Options
// ============================================================================

interface IntervalOption {
  label: string;
  value: number;
}

const intervalOptions: IntervalOption[] = [
  { label: "1 minute", value: 60_000 },
  { label: "2 minutes", value: 120_000 },
  { label: "5 minutes", value: 300_000 },
  { label: "10 minutes", value: 600_000 },
  { label: "15 minutes", value: 900_000 },
  { label: "30 minutes", value: 1_800_000 },
];

// ============================================================================
// Menu Registration
// ============================================================================

function registerMenuItems(): void {
  // Separator before auto-recover options
  registerMenuItem("file", {
    id: "file:autoRecover:separator",
    label: "",
    separator: true,
  });

  // Enable/Disable toggle
  registerMenuItem("file", {
    id: "file:autoRecover:toggle",
    label: "AutoRecover",
    get checked() {
      return currentEnabled;
    },
    action: async () => {
      currentEnabled = !currentEnabled;
      await setAutoRecoverSettingsBackend(currentEnabled, currentIntervalMs);
      if (currentEnabled) {
        startTimer();
      } else {
        stopTimer();
      }
    },
  });

  // Interval submenu
  registerMenuItem("file", {
    id: "file:autoRecover:interval",
    label: "AutoRecover Interval",
    children: intervalOptions.map((opt) => ({
      id: `file:autoRecover:interval:${opt.value}`,
      label: opt.label,
      get checked() {
        return currentIntervalMs === opt.value;
      },
      action: async () => {
        currentIntervalMs = opt.value;
        await setAutoRecoverSettingsBackend(currentEnabled, currentIntervalMs);
        if (currentEnabled) {
          startTimer();
        }
      },
    })),
  });
}

// ============================================================================
// Lifecycle
// ============================================================================

async function activate(_context: ExtensionContext): Promise<void> {
  await loadSettings();
  registerMenuItems();
  startTimer();
}

function deactivate(): void {
  stopTimer();
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.auto-recover",
    name: "AutoRecover",
    version: "1.0.0",
    description:
      "Automatically saves a recovery copy of the workbook at regular intervals to prevent data loss.",
  },
  activate,
  deactivate,
};
export default extension;
