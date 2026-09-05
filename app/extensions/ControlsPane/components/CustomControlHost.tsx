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
// CONTEXT: The srcdoc bridge, the postMessage protocol, the e.source integrity
//          check and the live-frame budget now live in ONE place —
//          extensions/_shared/scriptFrame — and this host imports them (M6b).
//          They used to be REPLICATED here from
//          Controls/Shape/shapeRenderer.ts, byte for byte, with this note
//          declaring the duplication; two copies of one protocol is a fork
//          waiting to happen, and the promise a script author is given is that
//          their HTML works unchanged in both hosts.
//          WHAT STAYED SEPARATE, deliberately: the on-grid wrapper is welded to
//          canvas-viewport overlay math (header clipping, absolute positioning
//          over the canvas parent, pointer-events:none click-through) that a
//          pane card must not inherit. Only the DOCUMENT and the PROTOCOL are
//          shared; each host still owns its own element.
//          THE INPUT GATE IS SHARED TOO, and was not. M6b split `ui.htmlInput`
//          out of `ui.html` on the premise that a frame granted only `ui.html`
//          PAINTS and cannot be typed or clicked into. That was true of the
//          on-grid host, whose frame is `pointer-events: none` forever and
//          whose every pixel of input arrives through the shims that
//          `render.setHitRegions` (the gated door) creates — and false here:
//          this card's frame was hardcoded `pointer-events: auto`, so the SAME
//          script's SAME document took clicks, focus, text selection and
//          KEYSTROKES with the paint-only grant. A distributed script declaring
//          `// @capability ui.html` could paint `<input type=password>` inside
//          Calcula's own chrome and read what was typed into it. So the card's
//          frame is hit-transparent until the script claims input, through the
//          same `render.setHitRegions` door the on-grid host uses — the split
//          is only real if both hosts implement it.
//          AND HIT-TRANSPARENCY IS THE MOUSE HALF ONLY. An iframe keeps its
//          place in the tab order whatever its `pointer-events` say, so the
//          same password field was still reachable with Tab and still read what
//          was typed. The frame is `inert` until the same claim as well
//          (`setScriptFrameInert`, shared with the on-grid host, whose frame is
//          inert in both modes because its input arrives as synthesized
//          messages and never as focus).

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
import {
  SHAPE_HIT_REGIONS_EVENT,
  type ShapeHitRegion,
} from "@api/scriptHost/shapeHitRegionSpec";
import type { ControlValue } from "@api/controlValues";
import {
  buildScriptFrameDocument,
  claimScriptFrameSlot,
  createScriptFrameRouter,
  postToScriptFrame,
  readScriptFrameThemeTokens,
  releaseScriptFrameSlot,
  setScriptFrameInert,
} from "../../_shared/scriptFrame";
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
  /**
   * Whether the script has a LIVE hit-region claim on this card — the pane's
   * flavour of `render.setHitRegions`, and the only thing that makes the card's
   * frame take the user's input (see the header's INPUT GATE note).
   *
   * A claim's RECTANGLES are frame-local grid geometry (shapeHitRegionSpec.ts),
   * and a pane card has no grid under it and is laid out by the pane rather
   * than by the script — there is nothing here for a rectangle to protect and
   * no stable space to measure one in. So the pane takes the DECISION out of
   * the declaration and not the geometry: non-empty claims the whole card body,
   * empty (which is also what the script host emits when a script unmounts)
   * returns it to paint-only. Half-honouring the rectangles against a box the
   * script cannot see would be a claim that is interactive in some of the
   * places its author asked for and not others, with nothing saying so.
   *
   * The claim is proof of the grant by itself: `render.setHitRegions` is
   * broker-gated on `ui.htmlInput` (allowlist.ts), so this event can only ever
   * arrive for a script that holds it. This host reads no capability of its
   * own, exactly like the on-grid one.
   */
  inputClaimed: boolean;
}

const runtimes = new Map<string, PaneScriptRuntime>();
const runtimeListeners = new Map<string, Set<() => void>>();
/** Live iframe element per control (for shape:sendMessage forwarding and the
 *  postMessage integrity check). */
const paneFrames = new Map<string, HTMLIFrameElement>();

function getOrCreateRuntime(controlId: string): PaneScriptRuntime {
  let rt = runtimes.get(controlId);
  if (!rt) {
    rt = { html: null, declared: [], values: new Map(), inputClaimed: false };
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
  releaseScriptFrameSlot(controlId);
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

  // Script -> host: the INPUT CLAIM. `render.setHitRegions` is the only door
  // in the object surface that costs `ui.htmlInput`, so it is the only thing
  // that may turn this card's frame from a picture into a surface that takes
  // the user's clicks and keystrokes. Without this listener the card was
  // interactive for every script that could paint at all, and the whole M6b
  // split existed on the on-grid host only.
  wiringCleanups.push(
    onAppEvent(SHAPE_HIT_REGIONS_EVENT, (detail) => {
      const d = detail as { instanceId: string | null; regions: ShapeHitRegion[] };
      if (!d.instanceId) return;
      const controlId = controlIdOfInstance(d.instanceId);
      // An on-grid shape's id belongs to Controls/index.ts, which applies the
      // rectangles literally; this host claims only its own "pane-" ids.
      if (!controlId) return;
      const rt = getOrCreateRuntime(controlId);
      const claimed = Array.isArray(d.regions) && d.regions.length > 0;
      if (rt.inputClaimed === claimed) return;
      rt.inputClaimed = claimed;
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

  // Script -> iframe: forward sendMessage into the card's iframe. Literally the
  // same poster the on-grid host uses (extensions/_shared/scriptFrame), so the
  // envelope's tag is spelled in one place for both hosts and for the frame
  // document itself.
  wiringCleanups.push(
    onAppEvent("shape:sendMessage", (detail) => {
      const d = detail as { instanceId: string; type: string; data: unknown };
      const controlId = controlIdOfInstance(d.instanceId);
      if (!controlId) return;
      postToScriptFrame(paneFrames.get(controlId) ?? null, d.instanceId, d.type, d.data);
    }),
  );

  // Iframe -> script: the postMessage bridge. The protocol, the e.source
  // integrity check and the reserved-type handling are the SHARED ones
  // (extensions/_shared/scriptFrame); `resolveFrame` returning null is how this
  // router says "not mine" for an on-grid shape's id, which shapeRenderer.ts's
  // router — listening on this same window — will claim instead.
  const onWindowMessage = createScriptFrameRouter({
    resolveFrame: (instanceId) => {
      const controlId = controlIdOfInstance(instanceId);
      if (!controlId) return null; // on-grid shapes are handled by shapeRenderer.ts
      return paneFrames.get(controlId) ?? null;
    },
    deliver: ({ instanceId, type, data }) => {
      emitAppEvent("shape:htmlMessage", { instanceId, type, data });
    },
    // A pane card is laid out by the pane, not by the frame's content, so the
    // intrinsic-size report is consumed and dropped rather than forwarded to
    // the script as if its own page had sent it.
  });
  window.addEventListener("message", onWindowMessage);
  wiringCleanups.push(() => window.removeEventListener("message", onWindowMessage));
}

/**
 * Drop EVERY pane card's script runtime and the frame budget its cards hold.
 *
 * The pane host's half of the DOCUMENT lifecycle, and the twin of the on-grid
 * `releaseAllShapeHtmlOverlays`. A pane control belongs to the workbook, so its
 * html, its declared properties and its frame all leave with the document — and
 * none of them did. The card releases its slot when React unmounts it, which
 * covers deleting a control and closing the pane, and File > Open unmounts
 * nothing: the cards stayed mounted showing the departed workbook's tiles, so
 * their charges stood against a cap that is 24 frames for the whole SESSION and
 * is SHARED with the on-grid host. Unlike an on-grid frame a pane frame is never
 * parked, so nothing could preempt it either — the next workbook simply had
 * fewer frames than it has tiles, and the refusal sentence's "this workbook
 * already has N" was counting the previous one's.
 *
 * Dropping the runtime is also what REMOVES the element, which is what keeps the
 * release honest: a card re-reads its runtime on every render, finds no html,
 * and React commits the frame away. Forgetting a charge whose iframe is still in
 * the DOM would be the same fiction in the other direction. So the maps are
 * cleared first and the listeners told afterwards, and that next render sees the
 * empty state rather than the departed workbook's.
 */
export function releaseAllPaneControlFrames(): void {
  // The UNION of the two maps, because they do not quite coincide: a control
  // whose script has not rendered yet holds a runtime and no frame, and a card
  // the budget refused holds a runtime and no frame either.
  const controlIds = new Set<string>([...runtimes.keys(), ...paneFrames.keys()]);
  runtimes.clear();
  paneFrames.clear();
  for (const controlId of controlIds) releaseScriptFrameSlot(controlId);
  for (const controlId of controlIds) notifyRuntime(controlId);
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
  // The same sweep the document lifecycle uses: a deactivate that tears the pane
  // out WITHOUT React unmounting the tree would otherwise leave the charge
  // standing with no id left to release it under, and an orphaned charge is a
  // slot no workbook ever gets back.
  releaseAllPaneControlFrames();
}

// ============================================================================
// Sandboxed iframe document (SHARED builder — see header CONTEXT note)
// ============================================================================

/** The pane card's flavour of the shared script-frame document: a 40px body
 *  floor, because rich content renders badly in the ribbon band (56px) and a
 *  card with no floor collapses to nothing while a script is still starting.
 *  Everything else — bridge, protocol, theme contract — is the one definition
 *  in extensions/_shared/scriptFrame, so a script's HTML works unchanged here
 *  and on the grid. */
function buildCardDocument(instanceId: string, userHtml: string): string {
  return buildScriptFrameDocument(instanceId, userHtml, {
    minHeightPx: 40,
    themeTokens: readScriptFrameThemeTokens(),
  });
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

  // The card PAINTS under "ui.html". Taking your clicks inside it is the
  // separate "ui.htmlInput" grant, and this is the call that asks for it —
  // without it the buttons below are a picture. A pane claim is per CARD: the
  // rectangle is grid geometry the pane has no use for, so any non-empty
  // declaration claims the whole card and [] hands it straight back.
  shape.render.setHitRegions([{ id: "card", x: 0, y: 0, width: 2000, height: 2000 }]);

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
  const inputClaimed = rt.inputClaimed;
  const hasBitmapRenderer = html == null && hasShapeBitmapRenderer(instanceId);
  const scriptExists = ObjectScriptManager.getScript("shape", instanceId) !== null;

  const [propsOpen, setPropsOpen] = useState(false);
  const [propsAnchor, setPropsAnchor] = useState<DOMRect | null>(null);

  // ---- iframe registration (sendMessage forwarding + integrity check) ----
  const frameElementRef = useRef<HTMLIFrameElement | null>(null);
  const frameCallbackRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      frameElementRef.current = el;
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

  // ---- the frame budget ----
  // Charged during render, not in an effect, so a refused frame is never
  // PAINTED once and then withdrawn. Safe here because a claim is idempotent
  // per instanceId: it re-prices an existing slot rather than counting a second
  // one, so React's double-invoked render costs nothing. The matching release
  // is an unmount effect below — a charge that outlives its frame is a slow
  // leak that eventually refuses a frame nothing is holding.
  const frameDocument = html != null ? buildCardDocument(instanceId, html) : null;
  const frameSlot =
    frameDocument !== null ? claimScriptFrameSlot(control.id, frameDocument.length) : null;
  useEffect(() => {
    if (frameDocument === null) releaseScriptFrameSlot(control.id);
  }, [frameDocument, control.id]);
  useEffect(() => () => releaseScriptFrameSlot(control.id), [control.id]);

  // ---- the input gate's KEYBOARD half ----
  // `pointerEvents` below is the mouse half and ONLY the mouse half: an iframe
  // keeps its place in the tab order however it is styled, so Tab left the pane
  // and landed inside the script's own document, and the credential field a
  // `ui.html`-only script painted was typeable after all. `inert` on the frame
  // makes the document inside it inert too — no focusable areas, no selection,
  // no hit testing — while leaving its scripts, its painting and the
  // postMessage bridge alone. It tracks the SAME claim the pointer half tracks,
  // so the card is hit-transparent and keyboard-unreachable together and
  // interactive to both devices together; two gates over one promise are two
  // things to keep in step. Re-applied whenever the document changes because a
  // frame React has just created starts with no attribute at all. Set here
  // rather than as a JSX prop because React 18's typings carry no `inert`.
  useEffect(() => {
    setScriptFrameInert(frameElementRef.current, !inputClaimed);
  }, [inputClaimed, frameDocument]);

  // ---- shared content: iframe / canvas / placeholder ----
  const body =
    frameDocument !== null && frameSlot?.granted === false ? (
      <div style={styles.placeholder}>
        <div style={styles.placeholderName}>{control.name}</div>
        <div style={styles.placeholderHint}>{frameSlot.message}</div>
      </div>
    ) : frameDocument !== null ? (
      <iframe
        ref={frameCallbackRef}
        // allow-scripts only: with srcdoc this gives the iframe an opaque
        // origin, so its scripts cannot reach the parent window, app-origin
        // storage, or __TAURI__. The postMessage bridge is the only path.
        sandbox="allow-scripts"
        srcDoc={frameDocument}
        // THE INPUT GATE. Paint-only by default — `ui.html` promises drawing
        // and nothing else, so the frame is hit-transparent to the mouse here
        // and `inert` to the keyboard in the effect above (hit-transparency
        // alone left it in the tab order, which is a second way in and was
        // open). It goes interactive to both only while the script holds a live
        // `render.setHitRegions` claim, which the broker refuses without
        // `ui.htmlInput`. Clicks on the
        // card while it is paint-only still reach `handleBodyClick` on the
        // wrapper and become the same `shape:clicked` the on-grid host emits,
        // so a paint-only control keeps its one coarse click and loses the key
        // stream, which is exactly what the two consent sentences promise.
        style={inputClaimed ? { ...styles.iframe, pointerEvents: "auto" } : styles.iframe}
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
    // PAINT-ONLY BY DEFAULT. This used to read `pointerEvents: "auto"`, with a
    // comment explaining that pane cards are interactive hosts "unlike the
    // on-grid overlay" — which made `ui.html` alone worth clicks, focus and
    // keystrokes on this path while the on-grid path charged `ui.htmlInput` for
    // pointer input alone. The interactive value is now applied at the element
    // (see the render site) and only while the script's claim stands.
    pointerEvents: "none",
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
