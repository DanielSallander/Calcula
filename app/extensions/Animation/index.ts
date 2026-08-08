//! FILENAME: app/extensions/Animation/index.ts
// PURPOSE: Animation / Simulation playback extension entry point.
// CONTEXT: An animation advances a "clock"/driver value over a frame range while
//          the model recalculates and charts/cells repaint each frame. Frame
//          delivery is TRANSIENT (no permanent data change, no undo entries; the
//          model snaps back on stop). This extension owns the playback engine,
//          the drivers, the timeline UI and (later) export. Slice 0 bound the
//          gated backend channel; Slice 1 adds the playback engine + clock-cell
//          driver + a timeline panel, status-bar transport, and View-menu entry,
//          and force-restores the model on file/sheet lifecycle events.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerStatusBarItem,
  unregisterStatusBarItem,
  registerDialog,
  unregisterDialog,
  registerMenuItem,
  unregisterMenuItem,
} from "@api/ui";
import { onAppEvent, AppEvents } from "@api/events";
import { animationBackend } from "./lib/animationBackend";
import { playbackEngine } from "./lib/animationEngine";
import { loadAnimations, resetAnimations } from "./lib/animationStore";
import {
  SavedAnimationsSection,
  DriverSection,
  TransportSection,
  ExportSection,
} from "./components/TimelineSections";
import { TransportStatusItem } from "./components/TransportStatusItem";
import { AnimationDialog, ANIMATION_DIALOG_ID } from "./components/AnimationDialog";
import { FilmIcon } from "./components/icons";
import { installPlayOverlay } from "./overlay/playOverlay";

const PANEL_ID = "animation.timeline";
const STATUS_BAR_ID = "animation.transport";
const MENU_ITEM_ID = "view.animation";

const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  // Bind the gated backend door so lib/store code reaches the anim_* commands
  // through the same capability check as ctx.invokeBackend (A3).
  animationBackend.set(context.invokeBackend);

  // Timeline panel: four @api/layout sections. In the sidebar they stack
  // vertically; in the ribbon the driver/transport/export rows render inline
  // while the saved-animations list and Monte Carlo histogram demote to
  // launcher flyouts — so the panel is freely movable to either surface.
  context.ui.panels.register({
    id: PANEL_ID,
    title: "Animation",
    icon: React.createElement(FilmIcon),
    sections: [
      { id: `${PANEL_ID}.saved`, label: "Animations", component: SavedAnimationsSection },
      { id: `${PANEL_ID}.driver`, label: "Driver", component: DriverSection },
      { id: `${PANEL_ID}.playback`, label: "Playback", component: TransportSection },
      { id: `${PANEL_ID}.export`, label: "Export", component: ExportSection },
    ],
    defaultPlacement: "sidebar",
    priority: 12,
  });
  cleanupFns.push(() => context.ui.panels.unregister(PANEL_ID));

  // Status-bar transport (compact play/pause + frame readout; hides when idle).
  registerStatusBarItem({
    id: STATUS_BAR_ID,
    component: TransportStatusItem,
    alignment: "left",
    priority: 30,
  });
  cleanupFns.push(() => unregisterStatusBarItem(STATUS_BAR_ID));

  // View menu entry to open the panel.
  registerMenuItem("view", {
    id: MENU_ITEM_ID,
    label: "Animation Timeline",
    icon: React.createElement(FilmIcon, { size: 14 }),
    action: () => context.ui.panels.open(PANEL_ID),
  });
  cleanupFns.push(() => unregisterMenuItem("view", MENU_ITEM_ID));

  // Create / edit dialog for saved animations.
  registerDialog({ id: ANIMATION_DIALOG_ID, title: "Animation", component: AnimationDialog, priority: 100 });
  cleanupFns.push(() => unregisterDialog(ANIMATION_DIALOG_ID));

  // On-canvas play control (floating pill; appears while a driver is loaded).
  cleanupFns.push(installPlayOverlay());

  // E2E handle on the LIVE engine (mirrors __CALCULA_PANEL_REGISTRY__ in
  // shell/bootstrap.ts). Two facts make this necessary rather than convenient:
  //
  //   1. There is NO WAY IN THE PRODUCT to unload a driver. Every lifecycle
  //      event above calls `stopAndRestore`, which restores the model and leaves
  //      the driver loaded; the panel's button is labelled "Stop" and does the
  //      same; closing the panel does nothing. Only `clearDriver` unloads, and
  //      nothing calls it. So the play pill, once shown, stays on A1:C2 until
  //      the page reloads — see open-decisions-2026-08.md §2q, which is about
  //      the product, not the tests.
  //   2. A test cannot reach the engine any other way. The dev `__calcImport`
  //      bridge performs a real dynamic import, which for a STATEFUL module
  //      yields a second instance with its own clock — measured: it reported
  //      `frameCount: 0` while the pill on screen read "11/11". A cleanup built
  //      on that silently does nothing.
  //
  // When (1) is fixed this handle should go with it.
  (window as unknown as Record<string, unknown>).__CALCULA_ANIMATION__ = { playbackEngine };
  cleanupFns.push(() => {
    delete (window as unknown as Record<string, unknown>).__CALCULA_ANIMATION__;
  });

  // Load saved animations for the already-open workbook, and on file open/new.
  void loadAnimations();
  cleanupFns.push(onAppEvent(AppEvents.AFTER_OPEN, () => void loadAnimations()));
  cleanupFns.push(onAppEvent(AppEvents.AFTER_NEW, () => resetAnimations()));

  // Undo/redo of a saved-animation change restores the backend blob and fires
  // "animation:refresh" (the shell objects-domain fan-out) — re-sync the store so
  // the panel reflects the restored state without a file reopen.
  const onAnimationRefresh = (): void => void loadAnimations();
  window.addEventListener("animation:refresh", onAnimationRefresh);
  cleanupFns.push(() => window.removeEventListener("animation:refresh", onAnimationRefresh));

  // Transient guarantee: never let an animated frame be saved or leak across a
  // sheet/file change — force-stop (which restores the model) on these events.
  const restoreOn = [
    AppEvents.BEFORE_SAVE,
    AppEvents.BEFORE_OPEN,
    AppEvents.BEFORE_NEW,
    AppEvents.BEFORE_CLOSE,
    AppEvents.SHEET_CHANGED,
  ];
  for (const ev of restoreOn) {
    cleanupFns.push(onAppEvent(ev, () => void playbackEngine.stopAndRestore()));
  }
}

function deactivate(): void {
  // Stop + restore the model and clear listeners before tearing down.
  void playbackEngine.dispose();
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (err) {
      console.error("[Animation] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.animation",
    name: "Animation",
    version: "1.0.0",
    description:
      "Animate simulations — a clock/driver sweeps a model while it recalculates and charts repaint each frame.",
  },
  activate,
  deactivate,
};

export default extension;
