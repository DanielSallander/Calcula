//! FILENAME: app/extensions/ControlsPane/components/CustomControlHost.tsx
// PURPOSE: Pane card body hosting a custom scripted control — a normal shape
//          object script (objectType "shape") whose instanceId is
//          "pane-" + control.id (design D6: no new script surface). The card
//          renders the script's HTML in a sandboxed iframe (or blits its
//          worker-realm canvas bitmap), keeps the script's declared properties
//          in a local map behind an editable Properties popover, and bridges
//          the exact shape:* app events the on-grid host uses (host.ts):
//            script -> host: shape:setHtmlContent / shape:declareProperties /
//                            shape:setProperty / shape:sendMessage
//            host -> script: shape:clicked / shape:propertyChanged /
//                            shape:htmlMessage
//          VALUE CONVENTION: shape.setProperty("value", v) is intercepted,
//          parsed (boolean/number/text heuristic) and committed via
//          commitValue() — that is how a custom control publishes its
//          GET.CONTROLVALUE value. The property event is still forwarded.
// CONTEXT: The iframe wrapper (srcdoc bridge + allow-scripts sandbox +
//          e.source integrity check) is REPLICATED from
//          Controls/Shape/shapeRenderer.ts rather than extracted to _shared:
//          the on-grid wrapper is welded to canvas-viewport overlay math
//          (header clipping, absolute positioning over the canvas parent,
//          pointer-events:none click-through) that a pane card must not
//          inherit, and extraction would require editing the Controls
//          extension. Only the ~25-line srcdoc/bridge core is duplicated.

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { emitAppEvent, onAppEvent } from "@api/events";
import { getShapeBitmap, hasShapeBitmapRenderer } from "@api";
import {
  Button,
  Stack,
  StatusText,
  useSurfaceLayout,
} from "@api/layout";
import {
  ObjectScriptManager,
  type DeclaredProperty,
  type ObjectScriptDefinition,
} from "@api/scriptableObjects";
import { saveObjectScript } from "@api/objectScriptBackend";
import type { ControlValue } from "@api/controlValues";
import type { PaneControl, PaneControlConfig } from "../lib/controlsPaneTypes";
import {
  commitValue,
  getControlById,
  updateControlAsync,
} from "../lib/controlsPaneStore";

// ============================================================================
// Instance-id convention ("pane-" + control.id, design D6)
// ============================================================================

export const PANE_CONTROL_INSTANCE_PREFIX = "pane-";

/** The object-script instanceId for a pane control. */
export function paneControlInstanceId(controlId: string): string {
  return PANE_CONTROL_INSTANCE_PREFIX + controlId;
}

/** Inverse of paneControlInstanceId; null when not a pane instance. */
function controlIdOfInstance(instanceId: string): string | null {
  return instanceId.startsWith(PANE_CONTROL_INSTANCE_PREFIX)
    ? instanceId.slice(PANE_CONTROL_INSTANCE_PREFIX.length)
    : null;
}

// ============================================================================
// Module-level script runtime (per control)
//
// The script may be mounted (by index.ts) long before — or without — this
// card ever rendering, and app events are transient. So the render state
// (HTML content, declared properties, property values) lives module-side,
// exactly like shapeRenderer.ts keeps module maps for the on-grid host.
// ============================================================================

interface PaneScriptRuntime {
  /** Latest shape:setHtmlContent payload; null until the script renders HTML. */
  html: string | null;
  /** Properties the script declared via shape.render.declareProperties(). */
  declared: DeclaredProperty[];
  /** Current property values (seeded from config, updated by set/edit). */
  values: Map<string, string>;
}

const runtimes = new Map<string, PaneScriptRuntime>();
const runtimeListeners = new Map<string, Set<() => void>>();
/** Live iframe element per control (for shape:sendMessage forwarding and the
 *  postMessage integrity check). */
const paneFrames = new Map<string, HTMLIFrameElement>();

function getOrCreateRuntime(controlId: string): PaneScriptRuntime {
  let rt = runtimes.get(controlId);
  if (!rt) {
    rt = { html: null, declared: [], values: new Map() };
    runtimes.set(controlId, rt);
  }
  return rt;
}

function subscribeRuntime(controlId: string, cb: () => void): () => void {
  let set = runtimeListeners.get(controlId);
  if (!set) {
    set = new Set();
    runtimeListeners.set(controlId, set);
  }
  set.add(cb);
  return () => {
    const s = runtimeListeners.get(controlId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) runtimeListeners.delete(controlId);
    }
  };
}

function notifyRuntime(controlId: string): void {
  const set = runtimeListeners.get(controlId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb();
    } catch {
      /* ignore listener errors */
    }
  }
}

/** The control's custom-config properties, or null for non-custom controls. */
function customConfigProperties(
  control: PaneControl,
): Record<string, string> | null {
  const cfg = control.config as { type?: string; properties?: Record<string, string> };
  return cfg && cfg.type === "custom" && cfg.properties ? cfg.properties : null;
}

/** Render a ControlValue as the string form scripts see via getProperty("value"). */
function controlValueToPropertyString(value: ControlValue): string {
  switch (value.kind) {
    case "number":
      return String(value.value);
    case "boolean":
      return value.value ? "true" : "false";
    case "text":
      return value.value;
    case "textList":
      return value.value.join(",");
  }
}

/** Human summary of a ControlValue for the card. */
function controlValueSummary(value: ControlValue | null): string {
  if (!value) return "(no value)";
  switch (value.kind) {
    case "boolean":
      return value.value ? "TRUE" : "FALSE";
    case "textList":
      return value.value.join(", ");
    default:
      return String(value.value);
  }
}

/**
 * Seed a control's runtime from its persisted state: config.properties for
 * property values (missing keys only — live script state wins) and the
 * published ControlValue as the "value" property. index.ts should call this
 * for every custom control BEFORE mounting its object script so the host
 * snapshot (host.ts "pane-" branch -> IPaneControlStoreService.getProperties)
 * seeds the worker with the persisted properties.
 */
export function seedCustomControlRuntime(control: PaneControl): void {
  const rt = getOrCreateRuntime(control.id);
  const persisted = customConfigProperties(control);
  if (persisted) {
    for (const [key, val] of Object.entries(persisted)) {
      if (!rt.values.has(key)) rt.values.set(key, val);
    }
  }
  if (control.value != null && !rt.values.has("value")) {
    rt.values.set("value", controlValueToPropertyString(control.value));
  }
}

/**
 * Current property map for a pane-hosted custom control (declared + set
 * properties, including the live "value"). This is what index.ts should back
 * IPaneControlStoreService.getProperties(controlId) with — host.ts seeds the
 * script's mount snapshot from it (read-only, no broker call).
 */
export function getCustomControlProperties(
  controlId: string,
): Record<string, string> {
  const rt = runtimes.get(controlId);
  if (!rt) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of rt.values) out[key] = val;
  return out;
}

/** Drop a control's runtime (call when the control is deleted). */
export function removeCustomControlRuntime(controlId: string): void {
  runtimes.delete(controlId);
  paneFrames.delete(controlId);
}

// ============================================================================
// Value convention — setProperty("value", v) publishes to GET.CONTROLVALUE
// ============================================================================

/** Heuristic parse per the value convention: "true"/"false" -> boolean,
 *  numeric string -> number, else text. */
function parseControlValueHeuristic(raw: string): ControlValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return { kind: "boolean", value: true };
  if (trimmed === "false") return { kind: "boolean", value: false };
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return { kind: "number", value: Number(trimmed) };
  }
  return { kind: "text", value: raw };
}

/** Sanitize an unknown declareProperties payload into DeclaredProperty[]. */
function sanitizeDeclaredProperties(props: unknown): DeclaredProperty[] {
  if (!Array.isArray(props)) return [];
  const out: DeclaredProperty[] = [];
  for (const p of props) {
    if (!p || typeof p !== "object") continue;
    const cand = p as { key?: unknown; label?: unknown; type?: unknown; defaultValue?: unknown };
    if (typeof cand.key !== "string" || cand.key.length === 0) continue;
    const type =
      cand.type === "color" || cand.type === "number" || cand.type === "boolean"
        ? cand.type
        : "text";
    out.push({
      key: cand.key,
      label: typeof cand.label === "string" && cand.label ? cand.label : cand.key,
      type,
      defaultValue: typeof cand.defaultValue === "string" ? cand.defaultValue : undefined,
    });
  }
  return out;
}

/**
 * Apply a property change to a pane control (from the script's setProperty OR
 * a Properties-popover edit): update the runtime map, persist non-"value"
 * properties into the control's custom config, intercept "value" into
 * commitValue (the GET.CONTROLVALUE publish path), and forward the SAME
 * shape:propertyChanged app event the on-grid host emits — host.ts relays it
 * into the worker's onPropertyChange and invalidates the shape bitmap.
 */
function applyPropertyChange(
  controlId: string,
  key: string,
  newValue: string,
  hostOldValue?: string,
): void {
  // Straggler guard: a message queued by a worker just before its control was
  // deleted must not resurrect the runtime entry (the backend write would fail
  // "not found" anyway) — drop events for controls no longer in the cache.
  if (!getControlById(controlId)) return;
  const rt = getOrCreateRuntime(controlId);
  const oldValue = rt.values.get(key) ?? hostOldValue ?? "";
  rt.values.set(key, newValue);

  if (key === "value") {
    // VALUE CONVENTION: publish to the backend value (one undo entry) and
    // trigger the targeted GET.CONTROLVALUE dependent recalc.
    void commitValue(controlId, parseControlValueHeuristic(newValue));
  } else {
    // Persist declared/set properties into the control's config so a
    // reloaded workbook re-seeds the script with them (mirrors the on-grid
    // host persisting each shape property, undo-wrapped backend-side).
    const control = getControlById(controlId);
    if (control && control.controlType === "custom") {
      const properties: Record<string, string> = {};
      for (const [k, v] of rt.values) {
        if (k !== "value") properties[k] = v;
      }
      const config: PaneControlConfig = { type: "custom", properties };
      // Never rejects — a backend failure comes back as { error } and is
      // already logged by the store.
      void updateControlAsync(controlId, { config });
    }
  }

  emitAppEvent("shape:propertyChanged", {
    instanceId: paneControlInstanceId(controlId),
    key,
    oldValue,
    newValue,
  });
  notifyRuntime(controlId);
}

// ============================================================================
// App-event wiring (module-level, idempotent)
// ============================================================================

let wiringCleanups: Array<() => void> | null = null;

/**
 * Wire the pane-instance shape:* render events and the iframe postMessage
 * bridge. Idempotent; index.ts should call this once in activate() (before
 * mounting any pane-control scripts) and disposeCustomControlWiring() on
 * deactivate. The card also calls it defensively on mount.
 */
export function ensureCustomControlWiring(): void {
  if (wiringCleanups) return;
  wiringCleanups = [];

  // Script -> host: HTML content for the card's iframe.
  wiringCleanups.push(
    onAppEvent("shape:setHtmlContent", (detail) => {
      const d = detail as { instanceId: string; html: string };
      const controlId = controlIdOfInstance(d.instanceId);
      if (!controlId) return;
      getOrCreateRuntime(controlId).html = d.html;
      notifyRuntime(controlId);
    }),
  );

  // Script -> host: declared properties (Properties popover schema).
  wiringCleanups.push(
    onAppEvent("shape:declareProperties", (detail) => {
      const d = detail as { instanceId: string; props: unknown };
      const controlId = controlIdOfInstance(d.instanceId);
      if (!controlId) return;
      const rt = getOrCreateRuntime(controlId);
      rt.declared = sanitizeDeclaredProperties(d.props);
      // Seed defaults for keys with no value yet (script/user values win).
      for (const prop of rt.declared) {
        if (prop.defaultValue !== undefined && !rt.values.has(prop.key)) {
          rt.values.set(prop.key, prop.defaultValue);
        }
      }
      notifyRuntime(controlId);
    }),
  );

  // Script -> host: setProperty — the value convention lives here so it works
  // even when the pane/card is not rendered (e.g. panel closed).
  wiringCleanups.push(
    onAppEvent("shape:setProperty", (detail) => {
      const d = detail as { instanceId: string; key: string; value: string; oldValue: string };
      const controlId = controlIdOfInstance(d.instanceId);
      if (!controlId) return;
      applyPropertyChange(controlId, d.key, d.value, d.oldValue);
    }),
  );

  // Script -> iframe: forward sendMessage into the card's iframe (same
  // envelope the on-grid host posts: target "shape-html" + instanceId).
  wiringCleanups.push(
    onAppEvent("shape:sendMessage", (detail) => {
      const d = detail as { instanceId: string; type: string; data: unknown };
      const controlId = controlIdOfInstance(d.instanceId);
      if (!controlId) return;
      const frame = paneFrames.get(controlId);
      if (frame?.contentWindow) {
        frame.contentWindow.postMessage(
          { target: "shape-html", instanceId: d.instanceId, type: d.type, data: d.data },
          "*",
        );
      }
    }),
  );

  // Iframe -> script: the postMessage bridge. Integrity check mirrors
  // shapeRenderer.ts: e.data is spoofable but e.source is not — only accept
  // messages that originate from the iframe registered for this control.
  const onWindowMessage = (e: MessageEvent) => {
    const data = e.data as
      | { source?: string; instanceId?: string; type?: string; data?: unknown }
      | undefined;
    if (!data || data.source !== "shape-html" || typeof data.instanceId !== "string") return;
    const controlId = controlIdOfInstance(data.instanceId);
    if (!controlId) return; // on-grid shapes are handled by shapeRenderer.ts
    const expectedFrame = paneFrames.get(controlId);
    if (!expectedFrame || e.source !== expectedFrame.contentWindow) return;
    emitAppEvent("shape:htmlMessage", {
      instanceId: data.instanceId,
      type: data.type,
      data: data.data,
    });
  };
  window.addEventListener("message", onWindowMessage);
  wiringCleanups.push(() => window.removeEventListener("message", onWindowMessage));
}

/** Tear down the module wiring and runtime state (extension deactivate). */
export function disposeCustomControlWiring(): void {
  if (wiringCleanups) {
    for (let i = wiringCleanups.length - 1; i >= 0; i--) {
      try {
        wiringCleanups[i]();
      } catch {
        /* ignore */
      }
    }
    wiringCleanups = null;
  }
  runtimes.clear();
  paneFrames.clear();
}

// ============================================================================
// Sandboxed iframe srcdoc (replicated bridge — see header CONTEXT note)
// ============================================================================

/**
 * Build the full srcdoc HTML for the card iframe, injecting the postMessage
 * bridge. Byte-for-byte the same protocol as the on-grid overlay
 * (shapeRenderer.buildIframeSrcDoc) so scripts and their HTML work unchanged
 * in both hosts. The body declares a sensible min-height; rich content
 * renders best with the Controls pane placed in the SIDEBAR (the ribbon band
 * only affords 56px).
 */
function buildIframeSrcDoc(instanceId: string, userHtml: string): string {
  // JSON.stringify yields a safe JS string literal; escaping "<" additionally
  // prevents "</script>" inside the id from terminating the script block.
  const idLiteral = JSON.stringify(instanceId).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif; font-size: 12px; overflow: hidden; min-height: 40px; }
  * { box-sizing: border-box; }
</style>
<script>
  var SHAPE_ID = ${idLiteral};
  window.calcula = {
    sendMessage: function(type, data) {
      parent.postMessage({ source: 'shape-html', instanceId: SHAPE_ID, type: type, data: data }, '*');
    }
  };
  window.addEventListener('message', function(e) {
    if (e.data && e.data.target === 'shape-html' && e.data.instanceId === SHAPE_ID) {
      window.dispatchEvent(new CustomEvent('shape-message', { detail: e.data }));
    }
  });
</script>
</head><body>${userHtml}</body></html>`;
}

// ============================================================================
// Script editor entry — "Edit code…"
// ============================================================================

/** Escape a user string for embedding inside the scaffold's JS literals. */
function scaffoldSafeName(name: string): string {
  return name.replace(/[\\"'\r\n<>]/g, "");
}

/**
 * Minimal scaffold for a NEW pane BUTTON script (modeled on the built-in
 * "button" scaffold in @api scaffolds): button.onClick fires when the user
 * clicks the pane button (ButtonControl emits the same "button:clicked" app
 * event the on-grid host emits, so host.ts's button.onClick forwarder works
 * unchanged for instanceId "pane-{controlId}").
 */
function buildPaneButtonScaffold(controlName: string): string {
  const name = scaffoldSafeName(controlName) || "My Button";
  return `// Pane button script for "${name}" — runs sandboxed in a worker realm.
// Access level: restricted

function setup(button) {
  // == Events ==
  // Runs your code when the user clicks the "${name}" button in the
  // Controls pane (the classic VBA move).
  button.onClick(({ x, y }) => {
    button.notify("${name} clicked!", "success");
    // Unlocked scripts can touch the grid here, e.g.:
    // button.api?.setCellValue(0, 0, "clicked");
  });

  // == Custom Methods (callable by other scripts) ==
  // button.expose("reset", () => button.log("reset"));
}
`;
}

/**
 * Minimal scaffold for a NEW pane-control script (modeled on the Shape
 * template catalog): declares properties, renders HTML, reacts to property
 * changes, and publishes its value with shape.setProperty("value", ...).
 */
function buildPaneControlScaffold(controlName: string): string {
  const name = scaffoldSafeName(controlName) || "My Control";
  return `// Pane control script for "${name}" — runs sandboxed in a worker realm.
// Publish the control's value with shape.setProperty("value", ...) so
// formulas can read it with =GET.CONTROLVALUE("${name}").
// NOTE: keep a sensible min-height on your HTML; rich content renders best
// with the Controls pane placed in the sidebar (the ribbon band is 56px).

function setup(shape) {
  shape.render.declareProperties([
    { key: "label", label: "Label", type: "text", defaultValue: "${name}" },
    { key: "value", label: "Value", type: "number", defaultValue: "0" },
  ]);

  var count = parseFloat(shape.getProperty("value")) || 0;

  function render() {
    var label = shape.getProperty("label") || "${name}";
    shape.render.setHtmlContent(
      '<div style="min-height:44px;height:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;">' +
        '<button onclick="calcula.sendMessage(' + "'decrement'" + ')" style="width:24px;height:24px;border:none;border-radius:50%;background:#e5e7eb;font-weight:700;cursor:pointer;">-</button>' +
        '<div style="text-align:center;">' +
          '<div style="font-size:16px;font-weight:700;color:#1a1a1a;">' + count + '</div>' +
          '<div style="font-size:9px;color:#888;">' + label + '</div>' +
        '</div>' +
        '<button onclick="calcula.sendMessage(' + "'increment'" + ')" style="width:24px;height:24px;border:none;border-radius:50%;background:#e5e7eb;font-weight:700;cursor:pointer;">+</button>' +
      '</div>'
    );
  }

  shape.render.onMessage(function (msg) {
    if (msg.type === "increment") count++;
    if (msg.type === "decrement") count--;
    shape.setProperty("value", String(count)); // publishes to GET.CONTROLVALUE
    render();
  });

  shape.onPropertyChange(function (change) {
    if (change.key === "value") {
      var v = parseFloat(change.newValue);
      if (!isNaN(v)) count = v;
    }
    render();
  });

  render();
}
`;
}

/**
 * Open the ScriptableObjects code editor on this control's object script,
 * scaffolding + persisting one first when none exists. The editor is opened
 * through the established "scriptable-objects:edit-script" app-event seam
 * (the same one Pivot/Slicer/Charts/Table/DefinedNames use — the
 * ScriptableObjects extension registers NO command-registry open-editor
 * command). Because we pre-register our pane-specific scaffold, the handler
 * finds the existing script and opens it instead of scaffolding the generic
 * template.
 *
 * The objectType follows the control kind: pane BUTTONS get an objectType
 * "button" script (host.ts's button.onClick forwarder only fires for a
 * mounted "button" script whose instanceId is "pane-{controlId}"); every
 * other kind (i.e. custom) gets the "shape" render-host script.
 */
export async function openControlScriptEditor(control: PaneControl): Promise<void> {
  const instanceId = paneControlInstanceId(control.id);
  const objectType = control.controlType === "button" ? "button" : "shape";
  let script = ObjectScriptManager.getScript(objectType, instanceId);
  if (!script) {
    const definition: ObjectScriptDefinition = {
      id: crypto.randomUUID(),
      name: `${control.name} (pane control)`,
      objectType,
      instanceId,
      source:
        objectType === "button"
          ? buildPaneButtonScaffold(control.name)
          : buildPaneControlScaffold(control.name),
      accessLevel: "restricted",
      description: `Custom scripted pane control "${control.name}"`,
    };
    ObjectScriptManager.registerScript(definition);
    try {
      // Persist to the workbook script store before opening the editor (so
      // loadAllObjectScripts / the editor window find it) — same order as
      // the ScriptableObjects scaffold path.
      await saveObjectScript(definition);
    } catch (e) {
      console.warn("[ControlsPane] Failed to persist new control script:", e);
    }
    try {
      // Mount immediately so the scaffold is live (a pane button's onClick
      // works) before the editor's first "save and apply". Local scripts
      // mount without consent; the manager re-mounts on later saves.
      await ObjectScriptManager.mountScript(definition.id);
    } catch (e) {
      console.warn("[ControlsPane] Failed to mount new control script:", e);
    }
    script = definition;
  }
  emitAppEvent("scriptable-objects:edit-script", {
    objectType,
    instanceId,
    objectName: script.name,
  });
}

// ============================================================================
// Properties popover
// ============================================================================

interface PropertyRow {
  key: string;
  label: string;
  type: DeclaredProperty["type"];
  value: string;
}

function buildPropertyRows(rt: PaneScriptRuntime): PropertyRow[] {
  const rows: PropertyRow[] = [];
  const seen = new Set<string>();
  for (const def of rt.declared) {
    seen.add(def.key);
    rows.push({
      key: def.key,
      label: def.label || def.key,
      type: def.type,
      value: rt.values.get(def.key) ?? def.defaultValue ?? "",
    });
  }
  // Undeclared-but-set properties (e.g. "value", or keys set by the script)
  // are still visible/editable as plain text rows.
  for (const [key, value] of rt.values) {
    if (seen.has(key)) continue;
    rows.push({ key, label: key, type: "text", value });
  }
  return rows;
}

function PropertyEditorRow({
  row,
  onCommit,
}: {
  row: PropertyRow;
  onCommit: (key: string, value: string) => void;
}): React.ReactElement {
  if (row.type === "boolean") {
    return (
      <label style={styles.propRow} title={row.key}>
        <span style={styles.propLabel}>{row.label}</span>
        <input
          type="checkbox"
          checked={row.value === "true"}
          onChange={(e) => onCommit(row.key, e.currentTarget.checked ? "true" : "false")}
        />
      </label>
    );
  }
  const inputType = row.type === "color" ? "color" : row.type === "number" ? "number" : "text";
  const defaultValue =
    row.type === "color" && !/^#[0-9a-fA-F]{6}$/.test(row.value) ? "#000000" : row.value;
  return (
    <label style={styles.propRow} title={row.key}>
      <span style={styles.propLabel}>{row.label}</span>
      <input
        // Re-seed the uncontrolled input when an external change lands.
        key={`${row.key}:${row.value}`}
        type={inputType}
        defaultValue={defaultValue}
        style={row.type === "color" ? styles.propColorInput : styles.propInput}
        onBlur={(e) => {
          if (e.currentTarget.value !== row.value) {
            onCommit(row.key, e.currentTarget.value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

function PropertiesPopover({
  control,
  anchorRect,
  onClose,
}: {
  control: PaneControl;
  anchorRect: DOMRect;
  onClose: () => void;
}): React.ReactElement {
  const rt = getOrCreateRuntime(control.id);
  const rows = buildPropertyRows(rt);

  const handleCommit = useCallback(
    (key: string, value: string) => {
      // Popover edits take the same path as the script's setProperty: local
      // map + persistence + value interception + shape:propertyChanged (the
      // event the on-grid Properties pane emits).
      applyPropertyChange(control.id, key, value);
    },
    [control.id],
  );

  const width = 240;
  const left = Math.max(4, Math.min(anchorRect.left, window.innerWidth - width - 8));
  const top = Math.min(anchorRect.bottom + 4, window.innerHeight - 60);

  return (
    <>
      <div style={styles.popoverOverlay} onMouseDown={onClose} />
      <div style={{ ...styles.popover, left, top, width }}>
        <div style={styles.popoverTitle}>Properties — {control.name}</div>
        {rows.length === 0 ? (
          <div style={styles.popoverEmpty}>
            No properties declared. The control script declares them with
            shape.render.declareProperties().
          </div>
        ) : (
          rows.map((row) => (
            <PropertyEditorRow key={row.key} row={row} onCommit={handleCommit} />
          ))
        )}
      </div>
    </>
  );
}

// ============================================================================
// The card body
// ============================================================================

interface Props {
  control: PaneControl;
  /**
   * Render body-only (no card chrome / name header / edit-code button) for
   * hosting inside ControlCard's shared card — the card supplies the name,
   * the "..." menu (Rename / Delete / Edit code...) and the outer border;
   * this host contributes the script content + the Properties popover.
   */
  embedded?: boolean;
}

/**
 * Custom scripted control card. Band (56px ribbon strip) and sidebar layouts,
 * driven by useSurfaceLayout() like the other pane cards. Sidebar placement is
 * preferred for rich HTML content — the band affords only a 56px strip.
 */
export function CustomControlHost({
  control,
  embedded = false,
}: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";
  const instanceId = paneControlInstanceId(control.id);

  // Re-render whenever the module runtime changes (html/props/values).
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    ensureCustomControlWiring();
    seedCustomControlRuntime(control);
    return subscribeRuntime(control.id, bump);
    // Seeding only fills missing keys — safe to re-run on control updates.
  }, [control, bump]);

  const rt = getOrCreateRuntime(control.id);
  const html = rt.html;
  const hasBitmapRenderer = html == null && hasShapeBitmapRenderer(instanceId);
  const scriptExists = ObjectScriptManager.getScript("shape", instanceId) !== null;

  const [propsOpen, setPropsOpen] = useState(false);
  const [propsAnchor, setPropsAnchor] = useState<DOMRect | null>(null);

  // ---- iframe registration (sendMessage forwarding + integrity check) ----
  const frameCallbackRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      if (el) {
        paneFrames.set(control.id, el);
      } else {
        paneFrames.delete(control.id);
      }
    },
    [control.id],
  );

  // ---- worker-realm canvas bitmap blit (single-flight + short poll) ----
  // getShapeBitmap returns the cached bitmap or null while a draw request is
  // in flight; the on-grid renderer retries every frame, here we poll briefly
  // after each runtime change (property changes invalidate the bitmap host-side).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!hasBitmapRenderer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let attempts = 0;
    const dpr = window.devicePixelRatio || 1;
    const tryDraw = () => {
      if (cancelled) return;
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      const bmp = getShapeBitmap(instanceId, w, h, dpr);
      if (bmp) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        }
        return;
      }
      if (attempts++ < 50) {
        window.setTimeout(tryDraw, 120);
      }
    };
    tryDraw();
    return () => {
      cancelled = true;
    };
  });

  // ---- host -> script click event (same payload as the on-grid host) ----
  const handleBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      emitAppEvent("shape:clicked", {
        instanceId,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    [instanceId],
  );

  const togglePropsPopover = useCallback((e: React.MouseEvent<HTMLElement>) => {
    setPropsAnchor(e.currentTarget.getBoundingClientRect());
    setPropsOpen((open) => !open);
  }, []);

  const handleEditCode = useCallback(() => {
    void openControlScriptEditor(control);
  }, [control]);

  const valueSummary = controlValueSummary(control.value);

  // ---- shared content: iframe / canvas / placeholder ----
  const body =
    html != null ? (
      <iframe
        ref={frameCallbackRef}
        // allow-scripts only: with srcdoc this gives the iframe an opaque
        // origin, so its scripts cannot reach the parent window, app-origin
        // storage, or __TAURI__. The postMessage bridge is the only path.
        sandbox="allow-scripts"
        srcDoc={buildIframeSrcDoc(instanceId, html)}
        style={styles.iframe}
        title={control.name}
      />
    ) : hasBitmapRenderer ? (
      <canvas ref={canvasRef} style={styles.canvas} />
    ) : (
      <div style={styles.placeholder}>
        <div style={styles.placeholderName}>{control.name}</div>
        <div style={styles.placeholderHint}>
          {scriptExists ? valueSummary : "No script yet"}
        </div>
      </div>
    );

  // ---- embedded: body-only, inside ControlCard's card chrome ----
  if (embedded) {
    if (band) {
      return (
        <>
          <div
            style={styles.embeddedBand}
            title={`${control.name}\nCustom scripted control\nValue: ${valueSummary}`}
          >
            <div style={styles.bandBody} onClick={handleBodyClick}>
              {body}
            </div>
            <button
              style={styles.iconButton}
              title="Properties"
              onClick={togglePropsPopover}
            >
              {"⋯"}
            </button>
          </div>
          {propsOpen && propsAnchor && (
            <PropertiesPopover
              control={control}
              anchorRect={propsAnchor}
              onClose={() => setPropsOpen(false)}
            />
          )}
        </>
      );
    }
    return (
      <div style={styles.embeddedSidebar}>
        <Stack gap={4}>
          <div style={styles.sidebarBody} onClick={handleBodyClick}>
            {body}
          </div>
          <div style={styles.embeddedFooter}>
            <Button size="sm" title="Properties" onClick={togglePropsPopover}>
              Properties
            </Button>
            <StatusText title="The value GET.CONTROLVALUE returns">
              {`Value: ${valueSummary}`}
            </StatusText>
          </div>
        </Stack>
        {propsOpen && propsAnchor && (
          <PropertiesPopover
            control={control}
            anchorRect={propsAnchor}
            onClose={() => setPropsOpen(false)}
          />
        )}
      </div>
    );
  }

  // ---- band: compact 56px card in the ribbon strip ----
  if (band) {
    return (
      <>
        <div
          style={styles.bandCard}
          title={`${control.name}\nCustom scripted control\nValue: ${valueSummary}`}
        >
          <div style={styles.bandBody} onClick={handleBodyClick}>
            {body}
          </div>
          <div style={styles.bandButtons}>
            <button style={styles.iconButton} title="Properties" onClick={togglePropsPopover}>
              {"⋯"}
            </button>
            <button style={styles.iconButton} title="Edit code…" onClick={handleEditCode}>
              {"</>"}
            </button>
          </div>
        </div>
        {propsOpen && propsAnchor && (
          <PropertiesPopover
            control={control}
            anchorRect={propsAnchor}
            onClose={() => setPropsOpen(false)}
          />
        )}
      </>
    );
  }

  // ---- sidebar / launcher flyout: stacked card ----
  return (
    <div style={styles.sidebarCard}>
      <Stack gap={4}>
        <div style={styles.sidebarHeader}>
          <div style={styles.sidebarName} title={control.name}>
            {control.name}
          </div>
          <Button size="sm" title="Properties" onClick={togglePropsPopover}>
            Properties
          </Button>
          <Button size="sm" title="Edit the control's script" onClick={handleEditCode}>
            {"</>"} Code
          </Button>
        </div>
        <div style={styles.sidebarBody} onClick={handleBodyClick}>
          {body}
        </div>
        <StatusText title="The value GET.CONTROLVALUE returns">
          {`Value: ${valueSummary}`}
        </StatusText>
      </Stack>
      {propsOpen && propsAnchor && (
        <PropertiesPopover
          control={control}
          anchorRect={propsAnchor}
          onClose={() => setPropsOpen(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Styles (band card matches RibbonFilterCard's 56px idiom)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  bandCard: {
    display: "flex",
    alignItems: "stretch",
    gap: "2px",
    padding: "2px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#c0c0c0",
    borderRadius: "3px",
    background: "#fff",
    cursor: "default",
    height: "56px",
    flexShrink: 0,
    maxWidth: "220px",
    minWidth: "120px",
    boxSizing: "border-box",
  },
  bandBody: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    borderRadius: "2px",
    display: "flex",
  },
  bandButtons: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    flexShrink: 0,
  },
  iconButton: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: "10px",
    color: "#555",
    padding: "2px 4px",
    lineHeight: 1.2,
  },
  sidebarCard: {
    border: "1px solid #c0c0c0",
    borderRadius: "3px",
    background: "#fff",
    padding: "6px",
  },
  // Embedded (inside ControlCard's chrome): no border/fixed card frame —
  // fill the host card's content row.
  embeddedBand: {
    display: "flex",
    alignItems: "stretch",
    gap: "2px",
    flex: 1,
    minWidth: 0,
    height: "100%",
    overflow: "hidden",
  },
  embeddedSidebar: {
    flex: 1,
    minWidth: 0,
  },
  embeddedFooter: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  sidebarName: {
    flex: 1,
    minWidth: 0,
    fontSize: "11px",
    fontWeight: 600,
    color: "#333",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  sidebarBody: {
    // Sensible minimum for script HTML; rich content prefers this sidebar
    // layout over the 56px band.
    minHeight: "120px",
    display: "flex",
    borderRadius: "2px",
    overflow: "hidden",
    border: "1px solid #e4e4e4",
    background: "#fff",
  },
  iframe: {
    border: "none",
    width: "100%",
    height: "100%",
    minHeight: "48px",
    background: "#fff",
    // Pane cards are interactive hosts (unlike the on-grid overlay, which is
    // pointer-events:none for grid click-through).
    pointerEvents: "auto",
    display: "block",
    flex: 1,
  },
  canvas: {
    width: "100%",
    height: "100%",
    minHeight: "48px",
    display: "block",
    flex: 1,
  },
  placeholder: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    minWidth: 0,
    padding: "4px",
  },
  placeholderName: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#333",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  },
  placeholderHint: {
    fontSize: "10px",
    color: "#888",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  },
  popoverOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 9998,
    background: "transparent",
  },
  popover: {
    position: "fixed",
    zIndex: 9999,
    background: "#fff",
    border: "1px solid #c0c0c0",
    borderRadius: "4px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    padding: "8px",
    maxHeight: "320px",
    overflowY: "auto",
  },
  popoverTitle: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#333",
    marginBottom: "6px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  popoverEmpty: {
    fontSize: "10px",
    color: "#888",
  },
  propRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginBottom: "4px",
  },
  propLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: "11px",
    color: "#444",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  propInput: {
    width: "110px",
    fontSize: "11px",
    padding: "2px 4px",
    border: "1px solid #c0c0c0",
    borderRadius: "2px",
  },
  propColorInput: {
    width: "40px",
    height: "20px",
    padding: 0,
    border: "1px solid #c0c0c0",
    borderRadius: "2px",
  },
};
