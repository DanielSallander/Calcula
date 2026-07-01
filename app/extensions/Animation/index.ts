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
import { registerStatusBarItem, unregisterStatusBarItem, registerDialog, unregisterDialog } from "@api/ui";
import { onAppEvent, AppEvents } from "@api/events";
import { animationBackend } from "./lib/animationBackend";
import { playbackEngine } from "./lib/animationEngine";
import { loadAnimations, resetAnimations } from "./lib/animationStore";
import { TimelinePanel } from "./components/TimelinePanel";
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

  // Timeline panel (sidebar).
  context.ui.panels.register({
    id: PANEL_ID,
    title: "Animation",
    icon: React.createElement(FilmIcon),
    sections: [{ id: `${PANEL_ID}.playback`, label: "Playback", component: TimelinePanel }],
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
  context.ui.menus.registerItem("view", {
    id: MENU_ITEM_ID,
    label: "Animation Timeline",
    icon: React.createElement(FilmIcon, { size: 14 }),
    action: () => context.ui.panels.open(PANEL_ID),
  });
  cleanupFns.push(() => context.ui.menus.unregisterItem("view", MENU_ITEM_ID));

  // Create / edit dialog for saved animations.
  registerDialog({ id: ANIMATION_DIALOG_ID, title: "Animation", component: AnimationDialog, priority: 100 });
  cleanupFns.push(() => unregisterDialog(ANIMATION_DIALOG_ID));

  // On-canvas play control (floating pill; appears while a driver is loaded).
  cleanupFns.push(installPlayOverlay());

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
