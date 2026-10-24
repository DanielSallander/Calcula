//! FILENAME: app/extensions/AutoRecover/index.ts
// PURPOSE: AutoRecover extension - saves the workbook at regular intervals to
//          prevent data loss.
// CONTEXT: Runs a background timer that calls auto_recover_save when the file
//          is dirty. Settings are persisted in AppState on the Rust side.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerMenuItem, unregisterMenuItem, IconAutoRecover, IconClock } from "@api";
import { createBackendChannel } from "@api/backendCommands";
import { showToast, type ToastHandle } from "@api/notifications";
import { createRefusalStreak, SKIPPED_SNAPSHOTS_NOTICE } from "./lib/refusalStreak";

const autoRecoverBackend = createBackendChannel("AutoRecover");

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
  return autoRecoverBackend.invoke<AutoRecoverSettings>(
    "get_auto_recover_settings",
  );
}

async function setAutoRecoverSettingsBackend(
  enabled: boolean,
  intervalMs: number,
): Promise<AutoRecoverSettings> {
  return autoRecoverBackend.invoke<AutoRecoverSettings>(
    "set_auto_recover_settings",
    {
      enabled,
      intervalMs,
    },
  );
}

async function autoRecoverSave(): Promise<string> {
  return autoRecoverBackend.invoke<string>("auto_recover_save");
}

// ============================================================================
// State
// ============================================================================

let timerId: ReturnType<typeof setInterval> | null = null;
let currentEnabled = true;
let currentIntervalMs = 300_000; // 5 minutes

/**
 * WHICH TIMER IS RUNNING: bumped every time it is stopped or started (a switch
 * off or on, an interval change, an activation, a deactivation). A tick reads
 * it before it awaits its save and compares when the save comes back, so a
 * save that was in flight when AutoRecover was switched off neither counts
 * toward a streak nor puts the card up: it answers a timer the user stopped
 * (review round 10, R10-3). A save in flight across an interval change is
 * set aside the same way; the streak itself carries on, and the first tick at
 * the new interval says whether copies are still being skipped.
 */
let timerGeneration = 0;

/** The skipped-copies card on screen now, to take back when its streak ends; null = none. */
let skippedCopiesCard: ToastHandle | null = null;

/**
 * Ticks the backend refused because the workbook kept changing (lib/refusalStreak.ts).
 * The notice is a TOAST -- it never blocks the work it is about -- put up ONCE
 * per streak, when the third refusal in a row comes in, and kept up (duration
 * 0) for as long as the streak lasts: the next written copy, any other outcome
 * (not_dirty included -- the user saved), File > AutoRecover switched off or
 * on, a reset or a deactivation takes it down through its handle (review
 * round 9, F4; the switch: round 10, R10-3). It was a 30-second card, so a
 * long streak went on skipping copies with nothing on screen; before that a
 * permanent one that nothing took back. One card per streak, never shown again
 * inside it -- not even after the user clicked it away.
 */
const refusals = createRefusalStreak({
  show() {
    // Never two cards: a card from an earlier streak is already down (its end
    // withdrew it), but take it back here too rather than trust that.
    skippedCopiesCard?.dismiss();
    skippedCopiesCard = showToast(SKIPPED_SNAPSHOTS_NOTICE, { type: "warning", duration: 0 });
  },
  withdraw() {
    skippedCopiesCard?.dismiss();
    skippedCopiesCard = null;
  },
});

// ============================================================================
// Timer Management
// ============================================================================

/** Stop the timer; a save still in flight from it no longer counts (`timerGeneration`). */
function stopTimer(): void {
  timerGeneration += 1;
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

/** (Re)start the timer at the current interval -- a new generation (stopTimer bumps it). */
function startTimer(): void {
  stopTimer();
  if (!currentEnabled || currentIntervalMs <= 0) return;

  timerId = setInterval(() => {
    void autoRecoverTick();
  }, currentIntervalMs);
}

/**
 * One background save. Never rejects: a timer callback has nobody to report to.
 */
async function autoRecoverTick(): Promise<void> {
  const generation = timerGeneration;
  let failure: { err: unknown } | null = null;
  try {
    await autoRecoverSave();
  } catch (err) {
    failure = { err };
  }
  // NOT THIS TIMER'S ANSWER ANY MORE: the timer that asked was stopped or
  // started again while the save ran, or AutoRecover has just been switched
  // off (`currentEnabled` flips at the click; the timer stops once the setting
  // is written). Either way nothing is skipping copies on its account -- a
  // refusal counted now would put a card up after AutoRecover is off, or
  // start the next streak one refusal early.
  if (generation !== timerGeneration || !currentEnabled) return;
  if (failure === null) {
    refusals.succeeded();
  } else {
    // "not_dirty" is expected when no changes have been made, and other errors
    // (disk full, etc.) stay silent for a background save -- both end a streak.
    // The retryable refusal (the workbook changed while it was being read, so
    // nothing was written) is COUNTED: three in a row is a toast.
    refusals.failed(failure.err);
  }
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

/** The File-menu items AutoRecover adds: its OWN ids, taken back on deactivate
 *  (wave E, Y14). The File menu is Standard Menus'; the interval item's
 *  children go with it. */
const OWN_FILE_MENU_ITEM_IDS = [
  "file:autoRecover:separator",
  "file:autoRecover:toggle",
  "file:autoRecover:interval",
] as const;

/** Registers the File-menu items; returns their cleanup. */
function registerMenuItems(): () => void {
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
    icon: IconAutoRecover,
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
      // A NEW STREAK EITHER WAY (review round 10, R10-3). Off: no timer, no
      // streak -- the card says copies are being skipped by a timer that no
      // longer runs, and it is a duration-0 card, so nothing else would ever
      // take it down (deactivate follows the same rule). On: a fresh count, as
      // an activation starts one. NOT on an interval change (below): the timer
      // goes on and copies are still being skipped, so the card is still true
      // -- and a reset there would announce again, inside one streak, a card
      // the user already pressed OK on.
      refusals.reset();
    },
  });

  // Interval submenu
  registerMenuItem("file", {
    id: "file:autoRecover:interval",
    label: "AutoRecover Interval",
    icon: IconClock,
    children: intervalOptions.map((opt) => ({
      id: `file:autoRecover:interval:${opt.value}`,
      label: opt.label,
      icon: IconClock,
      get checked() {
        return currentIntervalMs === opt.value;
      },
      action: async () => {
        currentIntervalMs = opt.value;
        await setAutoRecoverSettingsBackend(currentEnabled, currentIntervalMs);
        // The streak carries on, card and all: copies are still being
        // skipped at the new interval (see the toggle's reset).
        if (currentEnabled) {
          startTimer();
        }
      },
    })),
  });

  return () => {
    for (const id of OWN_FILE_MENU_ITEM_IDS) unregisterMenuItem("file", id);
  };
}

/** The cleanup of the menu items the current activation registered. */
let unregisterMenuItems: (() => void) | null = null;

// ============================================================================
// Lifecycle
// ============================================================================

async function activate(context: ExtensionContext): Promise<void> {
  autoRecoverBackend.set(context.invokeBackend);
  refusals.reset();
  await loadSettings();
  unregisterMenuItems?.();
  unregisterMenuItems = registerMenuItems();
  startTimer();
}

function deactivate(): void {
  stopTimer();
  // No timer, no streak: a card saying copies are being skipped would now be
  // describing something nothing is doing.
  refusals.reset();
  unregisterMenuItems?.();
  unregisterMenuItems = null;
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
