//! FILENAME: app/src/api/objectScriptBadge.ts
// PURPOSE: Shared "this object has a script" badge for grid-object overlays (T4)
//          — the transparency affordance that lets a user see code ON the object
//          (slicer, chart, ...) instead of hunting a pane. Generalizes the
//          shape-only precedent (Controls/Shape/shapeRenderer) into one @api
//          surface every object extension can use.
// CONTEXT: Two pieces: (1) a SYNCHRONOUS script-presence cache keyed by
//          objectType+instanceId — canvas render paths are hot and can't await
//          per frame, so presence is precomputed from loadAllObjectScripts() and
//          kept fresh by script events; (2) drawScriptBadge, the canvas pill
//          (lifted from the shape renderer). Gated on Design Mode, like shapes.

import { onAppEvent } from "./events";
import { loadAllObjectScripts } from "./objectScriptBackend";
import { getDesignMode, onDesignModeChange } from "./designMode";
import { requestOverlayRedraw } from "./gridOverlays";

// Event-name contracts (mirrors ScriptableObjectEvents in the ScriptableObjects
// extension; @api cannot import from an extension, so the strings are duplicated
// here as the stable contract).
const SCRIPTS_LOADED_EVENT = "scriptable-objects:scripts-loaded";
const SCRIPT_SAVED_EVENT = "scriptable-objects:script-saved";
const EDIT_SCRIPT_EVENT = "scriptable-objects:edit-script";

// ---------------------------------------------------------------------------
// Presence cache (synchronous; safe to call from hot canvas render paths)
// ---------------------------------------------------------------------------

const present = new Set<string>();
const listeners = new Set<() => void>();

/** Key an object: components key by type+instance, primitives by type alone. */
function presenceKey(objectType: string, instanceId?: string | null): string {
  return instanceId ? `${objectType}:${instanceId}` : `${objectType}:`;
}

/** Whether the given object instance has a script attached. Synchronous. */
export function hasObjectScript(objectType: string, instanceId?: string | null): boolean {
  return present.has(presenceKey(objectType, instanceId));
}

function notifyPresenceChange(): void {
  for (const l of listeners) l();
}

/** Subscribe to presence-cache changes (e.g. to repaint). Returns cleanup. */
export function onObjectScriptPresenceChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Rebuild the cache from the authoritative persisted-script list. */
export async function refreshObjectScriptPresence(): Promise<void> {
  try {
    const scripts = await loadAllObjectScripts();
    present.clear();
    for (const s of scripts) {
      present.add(presenceKey(s.objectType, s.instanceId ?? null));
    }
    notifyPresenceChange();
  } catch {
    // Backend unavailable (e.g. a non-Tauri test context) — leave the cache as is.
  }
}

/** Optimistically mark an object as scripted (e.g. when its editor opens). */
export function markObjectScript(objectType: string, instanceId?: string | null): void {
  const k = presenceKey(objectType, instanceId);
  if (!present.has(k)) {
    present.add(k);
    notifyPresenceChange();
  }
}

/** Mark an object as no longer scripted (e.g. on delete). */
export function unmarkObjectScript(objectType: string, instanceId?: string | null): void {
  if (present.delete(presenceKey(objectType, instanceId))) {
    notifyPresenceChange();
  }
}

// ---------------------------------------------------------------------------
// Canvas badge (lifted from Controls/Shape/shapeRenderer.ts drawScriptBadge)
// ---------------------------------------------------------------------------

/**
 * Draw a small script badge (a `< >` code-bracket pill) in the top-right corner
 * of an object's frame, at (x, y) with the object's width `w`.
 */
export function drawScriptBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
): void {
  const badgeSize = 16;
  const badgeX = x + w - badgeSize - 3;
  const badgeY = y + 3;
  const radius = 4;

  ctx.beginPath();
  ctx.moveTo(badgeX + radius, badgeY);
  ctx.lineTo(badgeX + badgeSize - radius, badgeY);
  ctx.arcTo(badgeX + badgeSize, badgeY, badgeX + badgeSize, badgeY + radius, radius);
  ctx.lineTo(badgeX + badgeSize, badgeY + badgeSize - radius);
  ctx.arcTo(badgeX + badgeSize, badgeY + badgeSize, badgeX + badgeSize - radius, badgeY + badgeSize, radius);
  ctx.lineTo(badgeX + radius, badgeY + badgeSize);
  ctx.arcTo(badgeX, badgeY + badgeSize, badgeX, badgeY + badgeSize - radius, radius);
  ctx.lineTo(badgeX, badgeY + radius);
  ctx.arcTo(badgeX, badgeY, badgeX + radius, badgeY, radius);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 120, 212, 0.85)";
  ctx.fill();

  const cx = badgeX + badgeSize / 2;
  const cy = badgeY + badgeSize / 2;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(cx - 2, cy - 3);
  ctx.lineTo(cx - 5, cy);
  ctx.lineTo(cx - 2, cy + 3);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx + 2, cy - 3);
  ctx.lineTo(cx + 5, cy);
  ctx.lineTo(cx + 2, cy + 3);
  ctx.stroke();
}

/**
 * Draw the script badge for an object IFF design mode is on AND the object has a
 * script. The one call an object overlay makes at the end of its render — same
 * gate the shape renderer uses.
 */
export function drawObjectScriptBadgeIfPresent(
  ctx: CanvasRenderingContext2D,
  objectType: string,
  instanceId: string | null | undefined,
  x: number,
  y: number,
  w: number,
): void {
  if (getDesignMode() && hasObjectScript(objectType, instanceId)) {
    drawScriptBadge(ctx, x, y, w);
  }
}

// ---------------------------------------------------------------------------
// Init: keep the cache fresh + repaint overlays when presence / mode changes
// ---------------------------------------------------------------------------

let initialized = false;

/**
 * Wire the presence cache to script events and repaint overlays when presence or
 * design mode changes. Idempotent; call once at startup. (Kept explicit rather
 * than running on import so importing @api has no side effects.)
 */
export function initObjectScriptBadges(): void {
  if (initialized) return;
  initialized = true;

  // Authoritative refresh on (re)load and save; optimistic mark when an editor
  // opens so the badge appears immediately for a brand-new script.
  onAppEvent(SCRIPTS_LOADED_EVENT, () => void refreshObjectScriptPresence());
  onAppEvent(SCRIPT_SAVED_EVENT, () => void refreshObjectScriptPresence());
  onAppEvent(EDIT_SCRIPT_EVENT, (detail) => {
    const d = detail as { objectType?: string; instanceId?: string | null } | undefined;
    if (d?.objectType) markObjectScript(d.objectType, d.instanceId ?? null);
  });

  // Repaint object overlays so badges appear/disappear immediately.
  onObjectScriptPresenceChange(() => requestOverlayRedraw());
  onDesignModeChange(() => requestOverlayRedraw());

  void refreshObjectScriptPresence();
}
