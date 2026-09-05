/**
 * ON THE GRID (M3) — the three things that landed together on the sheet itself,
 * driven live because none of them exists below a real canvas.
 *
 * WHAT IS PROVED, and why each needs the running app rather than a unit test:
 *
 *   M3a  THE CONTROL MENU. `installControlObjectMenu`
 *        (`extensions/Controls/lib/controlObjectMenu.ts`) is a capture-phase
 *        `contextmenu` listener on `window` that hit-tests through the SAME
 *        predicate Core's overlay registration uses (`lib/controlHitTest.ts`)
 *        and paints `components/ControlContextMenu.tsx`. Nothing below e2e has
 *        a canvas to right-click, a `[data-grid-canvas-layer]` for the
 *        listener's containment gate, or a Core that decides — from real
 *        pixels — whether to open the GRID's cell menu instead. The test
 *        asserts the menu OMITS what does not apply (a button gets no Flip and
 *        no Edit Script; a shape gets both), that a bare cell still opens the
 *        SHELL's menu, and that a right-click does not run the button's macro.
 *
 *   M3b  DECLARED HIT RECTANGLES. A shape script declares rectangles of its own
 *        `ui.html` frame through `render.setHitRegions`; the host places one
 *        transparent shim per rectangle ABOVE the frame
 *        (`Shape/shapeHitRegions.ts`, from `Shape/shapeRenderer.ts`'s
 *        `updateHtmlOverlay`). The claim is a Z-ORDER over a real iframe and a
 *        real canvas — `document.elementFromPoint` is the only honest oracle
 *        for it, and there is no such thing in jsdom.
 *
 *   M3c  A FORM EMBEDDED ON THE GRID. A placement is a minted UUID
 *        (`@api/scriptHost/embeddedFormPlacements`); the surface is a pane
 *        SESSION with `placement: "embedded"` painting the ONE `FormWidgetTree`
 *        (`components/scriptEmbed/ScriptEmbeddedFormSurface.tsx`) into a DOM
 *        host the grid's own paint pass positions (`lib/embeddedFormLayer.ts`).
 *        Only the host entry `openEmbeddedScriptForm` opens one, and
 *        `pane.close` is REFUSED for it.
 *
 * HOW IT IS DRIVEN. Everything is the product's own door: the controls seams
 * (`@api/controlsService`, `@api/buttonControlService`) create the objects, a
 * real Worker realm runs the scripts, `page.mouse` makes every click and
 * right-click, `@api`'s `insertRows` / `deleteRows` make the structural edits
 * (the same functions the ribbon calls, which is what emits the events the
 * layer listens for), and every read comes back from the backend, from the
 * registries, or from the DOM the renderer published.
 *
 * MODULE IDENTITY. Vite versions a module URL (`?t=...`) after an edit in its
 * import graph, so a plain `import()` can hand back a PHANTOM instance whose
 * registries are empty while the app's own holds a placement. Every read, every
 * write and every reset goes through `installAppImport`, which resolves the URL
 * the running app actually loaded. Taken verbatim from script-pane.spec.ts,
 * where it was proven, along with `callApi`, `invoke`, `mountScript`,
 * `callExposed` and the unconditional `afterEach`.
 *
 * WHY EVERY TEST RESETS UNCONDITIONALLY. An embedded placement left behind is a
 * DOM host with `pointer-events: auto` sitting over the next spec's cells; a
 * shape's hit shim left behind is an invisible click-eater; a control left
 * behind occupies its anchor cell so the next `createShape` is REFUSED. The
 * `afterEach` therefore removes placements one at a time through
 * `removeEmbeddedFormPlacement` (the user's own deletion path — it closes the
 * session before it forgets, which `resetEmbeddedFormPlacements` deliberately
 * does not), resets the pane registry and the hit-region store, deletes every
 * control this file made, unmounts every script, turns Design Mode off and
 * closes the control-properties task pane a shape click opens. The rig is
 * handed to `afterEach` BEFORE anything is created (`adopt`), so a failure
 * half-way through a build cannot strand a control on a cell the next test
 * needs.
 *
 * GRID REAL ESTATE. Columns DU/DV/DW (0-based 124/125/126), rows 897..909
 * (0-based 896..908). CHECKED AT AUTHORING TIME across all of `app/e2e`:
 *   - no file anywhere in `app/e2e` names a `DT`..`DZ` cell (the only
 *     three-figure columns in the suite are script-form.spec.ts DP..DR
 *     (119..121), script-form-distributed.spec.ts DQ125, script-preview.spec.ts
 *     DP, script-pane.spec.ts DS (122) and open-items-owner-calls.spec.ts
 *     columns 100/101);
 *   - no file names a cell in rows 880..929 in ANY column (`[A-Z]{1,3}(88x|89x|
 *     90x|91x|92x)` matches nothing), and every literal `900` in the suite is a
 *     millisecond timeout;
 *   - the literals 123..127 that DO appear in script-form.spec.ts and
 *     script-form-distributed.spec.ts are ROW indices in column DP/DQ, not
 *     column indices — checked one by one rather than counted, because "124
 *     appears somewhere" and "column 124 is taken" are different facts.
 * The one destructive gesture here — the row delete that orphans a placement —
 * therefore takes a row nothing else in the suite owns, and it is put back by an
 * insert at the same index so the sheet's geometry is returned as it was found.
 *
 * LOCALE. sv-SE, where the list separator is ";". Every number a bound widget
 * writes goes out TYPED, so no decimal comma is ever typed into the grid; the
 * seed is written by the probe as a NUMBER and every read is checked through
 * `api.getCellData().type`, the only typed read a script has.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { readGridGeometry, cellRangeRectFrom } from "../helpers/grid";

// ---------------------------------------------------------------------------
// Real estate (0-based) and the constants the product owns
// ---------------------------------------------------------------------------

/** DU. A = 0, so DA = 104 and DU = 124. */
const COL_DU = 124;
/** DW — where the embedded form's bindings live, clear of the controls above. */
const COL_DW = 126;

/** A cell with nothing on it: the negative control for "the GRID's menu still opens". */
const BARE_CELL = { row: 896, col: COL_DU, ref: "DU897" };
/** The button whose script must NOT run on a right-click. */
const BUTTON_ANCHOR = { row: 899, col: COL_DU, ref: "DU900" };
/** The shape whose `ui.html` frame declares hit rectangles. */
const SHAPE_ANCHOR = { row: 903, col: COL_DU, ref: "DU904" };
/** A bare cell BELOW the shape — in view whenever the shape is, which the cell
 *  above it is not once the anchor has been centred. */
const BARE_BELOW_SHAPE = { row: 914, col: COL_DU, ref: "DU915" };
/** The cell the embedded form hangs from. */
const FORM_ANCHOR = { row: 907, col: COL_DU, ref: "DU908" };

/** The embedded form's bound cells. */
const QTY = { row: 907, col: COL_DW, ref: "DW908" };
const NOTE = { row: 908, col: COL_DW, ref: "DW909" };

/** Everything this spec may write to, cleared between tests. */
const PATCH = { startRow: 890, startCol: COL_DU, endRow: 915, endCol: COL_DW + 2 };

/** The shape's box, in sheet pixels. Big enough to hold a claim and a gap. */
const SHAPE_W = 240;
const SHAPE_H = 160;

/**
 * The one rectangle the shape script claims, in FRAME-LOCAL CSS pixels — the
 * space `shapeHitRegionSpec.ts` defines and the only one a script may name.
 * Deliberately inset on all four sides so there is undeclared frame both above
 * and below it to click.
 */
const CLAIM = { id: "e2e-ok", x: 16, y: 16, width: 90, height: 40 };

/** The `@api` facade — the same module every extension imports. */
const API = "/src/api/index.ts";
/** The transparency spine; `@api/codeInventory` is where the panel reads it. */
const CODE_INVENTORY = "/src/api/codeInventory.ts";
/** The identity store for embedded placements (NOT re-exported by the barrel). */
const PLACEMENTS = "/src/api/scriptHost/embeddedFormPlacements.ts";
/** The two control seams. Creation goes through them, never through raw metadata. */
const CONTROLS_SERVICE = "/src/api/controlsService.ts";
const BUTTON_SERVICE = "/src/api/buttonControlService.ts";
/** The overlay registry and the grid snapshot — how a control's box is located. */
const GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const GRID_MODULE = "/src/api/grid.ts";
/** Controls' own hit test: the ORACLE for "is this pixel on a control?". */
const CONTROL_HIT_TEST = "/extensions/Controls/lib/controlHitTest.ts";
/** Controls' own selection store — what "the grid got the click" reads. */
const FLOATING_SELECTION = "/extensions/Controls/Button/floatingSelection.ts";
/** The hit-region store, for the unconditional reset. */
const SHAPE_HIT_REGIONS = "/extensions/Controls/Shape/shapeHitRegions.ts";
/** The task pane a shape click opens; closed in `afterEach`. */
const CONTROL_PROPERTIES_PANE = "control-properties";

/** The Shell's cell menu — `role="menu"` + `aria-label="Context menu"` (ContextMenu.tsx). */
const GRID_MENU = '[role="menu"][aria-label="Context menu"]';
/** Controls' own object menu (ControlContextMenu.tsx). */
const CONTROL_MENU = "[data-control-context-menu]";

/**
 * The two grid menu labels every orphan sentence quotes
 * (`EMBEDDED_FORM_RESTORE_MENU_LABEL` / `EMBEDDED_FORM_REMOVE_MENU_LABEL`).
 * Spelled here ONCE and then checked against the constants the app exports, so
 * this file cannot drift into asserting words the product stopped using.
 */
const RESTORE_LABEL = "Put This Form Back Here";
const REMOVE_LABEL = "Remove This Form From the Sheet";

// ---------------------------------------------------------------------------
// Page-side typing (no `any`: the harness lint treats it as an error)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/naming-convention --
 * Names the RUNTIME chose, not names this file gets to pick: `__TAURI__` is
 * Tauri's injected bridge, `__calcImport` is installed by main.tsx,
 * `__appImport` is this spec's own page-side global (double underscore is the
 * harness convention for them), and `ObjectScriptManager` is an exported
 * identifier. Renaming any of them would name nothing that exists. */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
};
/* eslint-enable @typescript-eslint/naming-convention */

/** What `api.getCellData` hands a script — the only typed read there is. */
interface TypedCell {
  value: string | number | boolean | null;
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
  formula?: string;
}

interface ScriptDefinitionInput {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  source: string;
  accessLevel: "restricted" | "unlocked";
  declaredCapabilities: string[];
}

/** One placement, as `embeddedFormPlacements.ts` hands it out. */
interface Placement {
  id: string;
  scriptId: string;
  sheetIndex: number;
  anchorRow: number;
  anchorCol: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  orphaned: boolean;
}

/** One row of `listScriptPanes()` (ScriptPaneSummary). */
interface PaneSummary {
  paneId: string;
  scriptId: string;
  docked: boolean;
  visible: boolean;
  placement: "sidebar" | "ribbon" | "embedded" | null;
  boundCells: number;
}

/** One `panes` row of `getScriptHeldState()` (ScriptPaneHeldEntry). */
interface PaneHeldEntry {
  paneId: string;
  scriptId: string;
  ownerName: string;
  ownerMissing: boolean;
  visible: boolean;
  placement: "sidebar" | "ribbon" | "embedded" | null;
  embedded: boolean;
  placementId: string | null;
  boundCells: number;
}

interface HeldState {
  panes: PaneHeldEntry[];
  forms: Array<{ showId: string; scriptId: string }>;
}

interface HeldSummary {
  panes: number;
  forms: number;
  embeddedForms: number;
}

/** One audit-ring row, as `getAuditTail` hands it out. */
interface AuditRow {
  scriptId: string;
  method: string;
  ok: boolean;
  error?: string;
}

/** A rectangle in CLIENT coordinates — what `page.mouse` takes. */
interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SheetInfo {
  index: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Plumbing (borrowed whole from script-pane.spec.ts — same traps, same answers)
// ---------------------------------------------------------------------------

/**
 * Install `window.__appImport(path)`: import the module at the URL the running
 * app loaded it from (resource timing, newest HMR version last), falling back
 * to the plain path only when the app has not loaded that module yet.
 */
async function installAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    if (w.__appImport) return;
    w.__appImport = async (modulePath: string) => {
      const entries = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === modulePath;
          } catch {
            return false;
          }
        });
      entries.sort();
      const url =
        entries.length > 0 ? entries[entries.length - 1] : new URL(modulePath, document.baseURI).href;
      return w.__calcImport(url);
    };
  });
}

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** Call one exported function of an app module, by the URL the app loaded. */
async function callApp<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(modulePath)) as Record<string, (...a: unknown[]) => unknown>;
      if (typeof m[fn] !== "function") throw new Error(`${modulePath} exports no function "${fn}"`);
      return (await m[fn](...args)) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

/** The same call against `@api`. */
async function callApi<T = unknown>(page: Page, fn: string, args: unknown[] = []): Promise<T> {
  return callApp<T>(page, API, fn, args);
}

/** Read one exported CONSTANT (not a function) of an app module. */
async function readConst<T = unknown>(page: Page, modulePath: string, name: string): Promise<T> {
  return page.evaluate(
    async ({ modulePath, name }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(modulePath)) as Record<string, unknown>;
      if (!(name in m)) throw new Error(`${modulePath} exports no "${name}"`);
      return m[name] as unknown;
    },
    { modulePath, name },
  ) as Promise<T>;
}

/** Script Security "enabled": the mount gate is a no-op, so nothing here can
 *  be explained by the OTHER consent gate. */
async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

async function sheets(page: Page): Promise<{ sheets: SheetInfo[]; activeIndex: number }> {
  return invoke(page, "get_sheets");
}

/** The sheet name the identity band prints — read the way the host reads it
 *  (`nameOfSheet`: the sheet whose `.index` is active, NOT the array position). */
async function activeSheetName(page: Page): Promise<string> {
  const r = await sheets(page);
  return r.sheets.find((s) => s.index === r.activeIndex)?.name ?? "";
}

/**
 * Register a script, GRANT its capabilities up front (a local script would
 * otherwise be JIT-prompted on first use, and that prompt is a modal this file
 * never asked for), mount it, and wait until its exposed methods are registered.
 */
async function mountScript(page: Page, def: ScriptDefinitionInput, exposes: string[]): Promise<void> {
  const outcome = await page.evaluate(
    async ({ def, exposes, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
        ObjectScriptManager: {
          registerScript: (d: unknown) => void;
          mountScript: (id: string) => Promise<void>;
          isScriptMounted: (id: string) => boolean;
        };
        recordCapabilityGrant: (scriptId: string, cap: string) => void;
        listExposedMethods: () => Array<{
          objectType: string;
          instanceId: string | null;
          methodName: string;
        }>;
      };
      m.ObjectScriptManager.registerScript({ ...def, description: null });
      for (const cap of def.declaredCapabilities) m.recordCapabilityGrant(def.id, cap);
      let mountError = "";
      try {
        await m.ObjectScriptManager.mountScript(def.id);
      } catch (e) {
        mountError = e instanceof Error ? e.message : String(e);
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000) {
        const listed = m.listExposedMethods();
        const ready = exposes.every((name) =>
          listed.some(
            (e) =>
              e.objectType === def.objectType &&
              e.instanceId === def.instanceId &&
              e.methodName === name,
          ),
        );
        if (ready) {
          return { ok: true, mounted: m.ObjectScriptManager.isScriptMounted(def.id), mountError };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false, mounted: m.ObjectScriptManager.isScriptMounted(def.id), mountError };
    },
    { def, exposes, api: API },
  );
  expect(
    outcome.ok,
    `"${def.name}" mounted=${outcome.mounted} but never exposed ${exposes.join(", ")}` +
      (outcome.mountError ? ` (mount said: ${outcome.mountError})` : ""),
  ).toBe(true);
}

async function unmountScript(page: Page, scriptId: string): Promise<void> {
  await page
    .evaluate(
      async ({ scriptId, api }) => {
        const w = window as unknown as AppWindow;
        const m = (await w.__appImport!(api)) as {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
          ObjectScriptManager: { unmountScript: (id: string) => void; removeScript: (id: string) => void };
        };
        try {
          m.ObjectScriptManager.unmountScript(scriptId);
        } catch {
          /* not mounted */
        }
        try {
          m.ObjectScriptManager.removeScript(scriptId);
        } catch {
          /* already gone */
        }
      },
      { scriptId, api: API },
    )
    .catch(() => undefined);
}

/** Call an exposed method and AWAIT it inside the page (bounded by the caller). */
async function callExposed<T = unknown>(
  page: Page,
  objectType: string,
  instanceId: string | null,
  method: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ objectType, instanceId, method, args, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        callExposedMethod: (t: string, i: string | null, n: string, ...a: unknown[]) => unknown;
      };
      return (await m.callExposedMethod(objectType, instanceId, method, ...args)) as unknown;
    },
    { objectType, instanceId, method, args, api: API },
  ) as Promise<T>;
}

/** Audit-ring rows for one script and one method, split by verdict. */
async function auditTally(
  page: Page,
  scriptId: string,
  method: string,
): Promise<{ total: number; ok: number; refused: number; errors: string[] }> {
  return page.evaluate(
    async ({ scriptId, method, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as { getAuditTail: (limit?: number) => AuditRow[] };
      const rows = m.getAuditTail(4000).filter((e) => e.scriptId === scriptId && e.method === method);
      return {
        total: rows.length,
        ok: rows.filter((e) => e.ok).length,
        refused: rows.filter((e) => !e.ok).length,
        errors: rows.filter((e) => !e.ok).map((e) => e.error ?? ""),
      };
    },
    { scriptId, method, api: API },
  );
}

// ---------------------------------------------------------------------------
// Coordinates — every point this file clicks is derived from LIVE geometry
// ---------------------------------------------------------------------------

/** 0-based column index -> its letters (0 = A). */
function colName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function refOf(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

/** Canvas CSS pixels -> client pixels, through the canvas LAYER's own rect —
 *  the basis Controls' `clientToCanvas` converts against, run backwards. */
async function canvasToClient(
  page: Page,
  canvasX: number,
  canvasY: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ canvasX, canvasY }) => {
      const layer = document.querySelector("[data-grid-canvas-layer]");
      if (!layer) throw new Error("the grid canvas layer is not mounted");
      const rect = layer.getBoundingClientRect();
      return { x: rect.left + canvasX, y: rect.top + canvasY };
    },
    { canvasX, canvasY },
  );
}

/** The centre of one cell, in client pixels, from live geometry. */
async function cellClientPoint(page: Page, ref: string): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const box = cellRangeRectFrom(ref, ref, geo);
  return canvasToClient(page, box.x + box.width / 2, box.y + box.height / 2);
}

/** A point `dx`/`dy` client pixels in from a cell's TOP-LEFT corner. */
async function cellCornerPoint(
  page: Page,
  ref: string,
  dx: number,
  dy: number,
): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const box = cellRangeRectFrom(ref, ref, geo);
  return canvasToClient(page, box.x + dx, box.y + dy);
}

/**
 * The CLIENT box of a floating control, computed the way Controls'
 * `floatingCanvasBounds` computes it — through the sanctioned gutter accessors,
 * never `config.rowHeaderWidth || 50`, because `||` cannot tell a collapsed
 * gutter (View > Headings off, a legal 0) from a missing one.
 */
async function controlClientBox(page: Page, instanceId: string): Promise<ClientBox> {
  const box = await page.evaluate(
    async ({ instanceId, overlays, grid }) => {
      const w = window as unknown as AppWindow;
      const ov = (await w.__appImport!(overlays)) as {
        getGridRegions: () => Array<{
          id: string;
          type: string;
          floating?: { x: number; y: number; width: number; height: number };
        }>;
      };
      const gm = (await w.__appImport!(grid)) as {
        getGridStateSnapshot: () => {
          config: Record<string, number>;
          viewport: { scrollX: number; scrollY: number };
          zoom: number;
        } | null;
        rowHeaderGutter: (c: Record<string, number>) => number;
        colHeaderGutter: (c: Record<string, number>) => number;
      };
      const region = ov.getGridRegions().find((r) => r.id === instanceId && r.type === "floating-control");
      if (!region?.floating) return null;
      const state = gm.getGridStateSnapshot();
      if (!state) return null;
      const zoom = state.zoom ?? 1;
      const canvasX = gm.rowHeaderGutter(state.config) + region.floating.x - state.viewport.scrollX;
      const canvasY = gm.colHeaderGutter(state.config) + region.floating.y - state.viewport.scrollY;
      const layer = document.querySelector("[data-grid-canvas-layer]");
      if (!layer) return null;
      const rect = layer.getBoundingClientRect();
      return {
        left: rect.left + canvasX * zoom,
        top: rect.top + canvasY * zoom,
        width: region.floating.width * zoom,
        height: region.floating.height * zoom,
      };
    },
    { instanceId, overlays: GRID_OVERLAYS, grid: GRID_MODULE },
  );
  expect(box, `no floating-control region is published for "${instanceId}"`).not.toBeNull();
  return box!;
}

/**
 * What the PRODUCT says is under a client point — Controls' own
 * `floatingControlRegionAtClientPoint`, the single predicate the menu and the
 * mouse share. Every point this file right-clicks is checked against it first,
 * so a failure below can never be "the test aimed at the wrong pixel".
 */
async function controlUnderPoint(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(
    async ({ x, y, hit }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(hit)) as {
        floatingControlRegionAtClientPoint: (cx: number, cy: number) => { id: string } | null;
      };
      return m.floatingControlRegionAtClientPoint(x, y)?.id ?? null;
    },
    { x, y, hit: CONTROL_HIT_TEST },
  );
}

// ---------------------------------------------------------------------------
// Objects on the grid — created through the SEAMS, never through raw metadata
// ---------------------------------------------------------------------------

async function createShapeControl(
  page: Page,
  anchor: { row: number; col: number },
  sheetIndex: number,
  name: string,
): Promise<string> {
  return page.evaluate(
    async ({ anchor, sheetIndex, name, cs, w: width, h: height }) => {
      const w2 = window as unknown as AppWindow;
      const m = (await w2.__appImport!(cs)) as {
        requireControlsProvider: () => {
          createShape: (r: unknown) => Promise<{ instanceId: string }>;
        };
      };
      const handle = await m.requireControlsProvider().createShape({
        sheetIndex,
        row: anchor.row,
        col: anchor.col,
        shapeType: "rectangle",
        width,
        height,
        name,
      });
      return handle.instanceId;
    },
    { anchor, sheetIndex, name, cs: CONTROLS_SERVICE, w: SHAPE_W, h: SHAPE_H },
  );
}

async function createButtonControl(
  page: Page,
  anchor: { row: number; col: number },
  sheetIndex: number,
  label: string,
): Promise<string> {
  return page.evaluate(
    async ({ anchor, sheetIndex, label, bs }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(bs)) as {
        requireButtonControlProvider: () => {
          createButton: (r: unknown) => Promise<{ instanceId: string }>;
        };
      };
      // NO `onSelect` AND NO `macroRef`, deliberately: the click has exactly one
      // route to a recorder — the mounted OBJECT SCRIPT's `button.onClick` — so
      // "the script ran" cannot be confused with "the inline source ran".
      const handle = await m.requireButtonControlProvider().createButton({
        sheetIndex,
        row: anchor.row,
        col: anchor.col,
        label,
      });
      return handle.instanceId;
    },
    { anchor, sheetIndex, label, bs: BUTTON_SERVICE },
  );
}

/** Delete a control through the seam that does the FULL teardown the user's own
 *  Delete key performs (scripts, overlays, caches, backend metadata). */
async function deleteControl(page: Page, instanceId: string): Promise<void> {
  await page
    .evaluate(
      async ({ instanceId, cs }) => {
        const w = window as unknown as AppWindow;
        const m = (await w.__appImport!(cs)) as {
          getControlsProvider: () => { deleteControl: (id: string) => Promise<boolean> } | null;
        };
        const provider = m.getControlsProvider();
        if (provider) await provider.deleteControl(instanceId);
      },
      { instanceId, cs: CONTROLS_SERVICE },
    )
    .catch(() => undefined);
}

/** Wait until the floating-control region for this id is published AND on screen. */
async function waitForControlPainted(page: Page, instanceId: string): Promise<ClientBox> {
  await expect
    .poll(async () => (await controlClientBox(page, instanceId).catch(() => null)) !== null, {
      timeout: 15_000,
      message: `the control "${instanceId}" never reached the grid's region list`,
    })
    .toBe(true);
  const box = await controlClientBox(page, instanceId);
  // Its own CENTRE must hit-test as this control, or every click below is aimed
  // at a pixel the product does not agree is on the object.
  await expect
    .poll(async () => controlUnderPoint(page, box.left + box.width / 2, box.top + box.height / 2), {
      timeout: 10_000,
      message: `the product's own hit test does not place "${instanceId}" under its own centre`,
    })
    .toBe(instanceId);
  return box;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** The test's hands inside a realm: typed cell reads and typed seed writes. */
function probeSource(): string {
  return [
    "function setup(shape) {",
    '  shape.expose("readCell", async (row, col) => shape.api.getCellData(row, col));',
    '  shape.expose("writeCell", async (row, col, value) => { await shape.api.setCellValue(row, col, value); return true; });',
    "}",
    "",
  ].join("\n");
}

/**
 * The button's object script. Its ONLY job is to record that the click path
 * reached it: `button.onClick` is fired from `button:clicked`, which Controls
 * emits from its `floatingObject:selected` handler in run mode.
 */
function buttonSource(): string {
  return [
    "function setup(button) {",
    "  var clicks = 0;",
    "  button.onClick(function () { clicks += 1; });",
    '  button.expose("clicks", async function () { return clicks; });',
    "}",
    "",
  ].join("\n");
}

/**
 * The shape's object script: paints an `ui.html` frame and declares one
 * rectangle of it. The two rows ride DIFFERENT capabilities (allowlist.ts):
 * painting is `ui.html`, claiming pointer input is `ui.htmlInput` (M6b split it
 * out, because ui.html's consent sentences only ever promised rendering). Both
 * are auto-granted to a LOCAL script, which this one is. The rectangle
 * is FRAME-LOCAL — the script names no grid pixel and can learn none.
 */
function shapeSource(): string {
  return [
    "// @capability ui.html",
    "// @capability ui.htmlInput",
    "function setup(shape) {",
    '  shape.expose("paint", async function () {',
    "    shape.render.setHtmlContent(",
    '      \'<div style="padding:6px">E2E frame</div>\'',
    "    );",
    "    return true;",
    "  });",
    '  shape.expose("claim", async function (regions) { shape.render.setHitRegions(regions); return true; });',
    "}",
    "",
  ].join("\n");
}

/**
 * The embedded form's script. `form.define(...)` is the layout the EMBEDDED
 * surface paints — `openEmbeddedScriptForm` reads `getScriptFormSpec`, which is
 * the "form" layout, not the pane's — so this is the same declaration a modal
 * would use, painted by the same `FormWidgetTree`.
 *
 * `ui.pane` is declared because an embedded session IS a pane session: it is
 * what `pane.close` and `pane.list` are gated on. `form.define` needs no
 * capability at all (allowlist.ts), which is why nothing else is declared.
 */
function formSource(): string {
  return [
    "// @capability ui.pane",
    "function setup(form) {",
    "  form.define({",
    '    title: "On-grid order",',
    "    children: [",
    `      { type: "number",  name: "qty",  label: "Quantity", bind: "${QTY.ref}", min: 0 },`,
    `      { type: "textbox", name: "note", label: "Note",     bind: "${NOTE.ref}", maxLength: 40 },`,
    '      { type: "label",   name: "hint", text: "Placed on the sheet" },',
    "    ],",
    "  });",
    // `pane.close` is a FIRE-AND-FORGET shim call, so its refusal never reaches
    // the script as a rejection — the audit ring and the surface still standing
    // are what this test reads. The call is exposed anyway so the gesture is
    // made by the SCRIPT, through its own facet, and not by the test.
    '  form.expose("closeFromScript", async function () { form.pane.close(); return true; });',
    '  form.expose("surfaces", async function () { return form.pane.list(); });',
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The rig — everything a test creates, so `afterEach` can undo all of it
// ---------------------------------------------------------------------------

interface Rig {
  sheetIndex: number;
  uniq: string;
  /** Every object-script id this test registered. */
  scriptIds: string[];
  /** Every on-grid control this test created. */
  controlIds: string[];
  /** The probe's instance id (a `shape` script with no control behind it). */
  probeId: string;
}

async function clearPatch(page: Page): Promise<void> {
  await invoke(page, "clear_range_with_options", {
    params: {
      startRow: PATCH.startRow,
      startCol: PATCH.startCol,
      endRow: PATCH.endRow,
      endCol: PATCH.endCol,
      applyTo: "all",
    },
  }).catch(() => undefined);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
}

/** Remove every embedded placement through the USER's own deletion path. */
async function removeEveryPlacement(page: Page): Promise<void> {
  await page
    .evaluate(
      async (placements) => {
        const w = window as unknown as AppWindow;
        const m = (await w.__appImport!(placements)) as {
          listEmbeddedFormPlacements: () => Array<{ id: string }>;
          removeEmbeddedFormPlacement: (id: string) => boolean;
        };
        // `removeEmbeddedFormPlacement`, one at a time, and NOT
        // `resetEmbeddedFormPlacements`: the reset is documented as having
        // exactly one legal caller (the workbook-swap sweep, which takes the
        // surfaces down FIRST), because its announce runs the renderer's
        // reconcile synchronously and a reconcile that finds a live surface
        // without its placement closes the session as "user" — the one close
        // reason that FLUSHES a pending bound write.
        for (const p of m.listEmbeddedFormPlacements()) m.removeEmbeddedFormPlacement(p.id);
      },
      PLACEMENTS,
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Structural edits, and the repair that always runs
// ---------------------------------------------------------------------------

/**
 * The compensating edit for every row insert/delete this file has made and NOT
 * yet undone, newest last.
 *
 * WHY IT IS NOT ENOUGH TO PUT THE ROW BACK AT THE END OF THE TEST. A row delete
 * is the one gesture here that reaches OUTSIDE this file's real estate: it
 * shifts every row below it in EVERY column, for the whole shared page. If the
 * assertion between the delete and its repair goes red, Playwright leaves the
 * repair unrun and every later spec in the run reads its own cells one row off
 * — a wedge whose symptom is somebody else's failure. The repairs are recorded
 * as they are made and drained unconditionally in `afterEach`, so a failure
 * costs one red test and not the rest of the suite.
 */
const pendingRowRepairs: Array<{ op: "insertRows" | "deleteRows"; at: number; count: number }> = [];

async function insertRowsTracked(page: Page, at: number, count: number): Promise<void> {
  await callApi(page, "insertRows", [at, count]);
  pendingRowRepairs.push({ op: "deleteRows", at, count });
}

async function deleteRowsTracked(page: Page, at: number, count: number): Promise<void> {
  await callApi(page, "deleteRows", [at, count]);
  pendingRowRepairs.push({ op: "insertRows", at, count });
}

/** Undo the most recent tracked edit — the test's own "put the sheet back". */
async function undoLastRowEdit(page: Page): Promise<void> {
  const repair = pendingRowRepairs.pop();
  if (!repair) return;
  await callApi(page, repair.op, [repair.at, repair.count]);
}

/** Drain whatever is left, newest first. Unconditional; never throws. */
async function repairRowGeometry(page: Page): Promise<void> {
  while (pendingRowRepairs.length > 0) {
    const repair = pendingRowRepairs.pop()!;
    await callApi(page, repair.op, [repair.at, repair.count]).catch(() => undefined);
  }
}

/**
 * `adopt` hands the rig to the test's `afterEach` BEFORE anything is created.
 *
 * WHY IT IS NOT JUST A RETURN VALUE. Every object here occupies an ANCHOR CELL,
 * and `createShape` REFUSES rather than overwrites when the anchor already
 * holds a control. If a build below threw and the rig were only handed back on
 * success, the failed test's shape would sit on DU904 for the rest of the file
 * and every later test would fail at creation — blaming the seam for a mount
 * that went wrong once.
 */
async function buildRig(page: Page, adopt: (rig: Rig) => void): Promise<Rig> {
  await installAppImport(page);
  await allowScripts(page);
  await removeEveryPlacement(page);
  await callApi(page, "resetScriptPanes").catch(() => undefined);
  await callApi(page, "setDesignMode", [false]).catch(() => undefined);
  await clearPatch(page);

  const uniq = Date.now().toString(36);
  const rig: Rig = {
    sheetIndex: (await sheets(page)).activeIndex,
    uniq,
    scriptIds: [],
    controlIds: [],
    probeId: `e2e-grid-probe-${uniq}`,
  };
  adopt(rig);

  rig.scriptIds.push(rig.probeId);
  await mountScript(
    page,
    {
      id: rig.probeId,
      name: "On-Grid Probe",
      objectType: "shape",
      instanceId: rig.probeId,
      source: probeSource(),
      accessLevel: "unlocked",
      declaredCapabilities: [],
    },
    ["readCell", "writeCell"],
  );
  return rig;
}

async function readCell(page: Page, rig: Rig, cell: { row: number; col: number }): Promise<TypedCell> {
  return callExposed<TypedCell>(page, "shape", rig.probeId, "readCell", [cell.row, cell.col]);
}

async function writeCell(
  page: Page,
  rig: Rig,
  cell: { row: number; col: number },
  value: string | number,
): Promise<void> {
  await callExposed(page, "shape", rig.probeId, "writeCell", [cell.row, cell.col, value]);
}

/**
 * Put an anchor cell into view with room BELOW AND RIGHT of it.
 *
 * A bare `navigateTo(anchor)` scrolls the anchor to the viewport's bottom edge,
 * where a 240x160 shape is clipped by the canvas — and `updateHtmlOverlay`'s
 * visibility branch then HIDES the frame and removes every shim, so a claim
 * test would measure a scroll position rather than a claim. Navigating first to
 * a cell well below and right pushes the anchor into the body of the viewport;
 * the second navigation only moves the SELECTION.
 */
async function bringIntoView(page: Page, row: number, col: number): Promise<void> {
  // Same sequence as `GridHelper.navigateTo`, and the trailing focus move is
  // not decoration: the container has `tabIndex={0}` and owns every grid key
  // handler, so a spec that leaves focus in the Name Box types into it.
  const nameBox = page.locator('input[aria-label="Name Box"]');
  for (const ref of [refOf(row + 16, col + 6), refOf(row, col)]) {
    await nameBox.click();
    await nameBox.fill(ref);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
  }
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(200);
}

/** The cell reference the Name Box is showing — the product's own read of
 *  "where is the selection". */
async function selectedRef(page: Page): Promise<string> {
  return (await page.locator('input[aria-label="Name Box"]').inputValue()).toUpperCase();
}

/** Is this control in Controls' own selection set? The store the extension
 *  reads, not a re-derivation of it. */
async function isControlSelected(page: Page, instanceId: string): Promise<boolean> {
  return page.evaluate(
    async ({ instanceId, sel }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(sel)) as {
        isFloatingControlSelected: (id: string) => boolean;
      };
      return m.isFloatingControlSelected(instanceId);
    },
    { instanceId, sel: FLOATING_SELECTION },
  );
}

async function deselectControls(page: Page): Promise<void> {
  await callApp(page, FLOATING_SELECTION, "deselectFloatingControl").catch(() => undefined);
}

/**
 * Put away the side effect of a click that SELECTED a shape: Controls opens the
 * control-properties task pane on every such click, and a sidebar appearing
 * NARROWS the grid — so every pixel measured before it is stale. Callers pair
 * this with `deselectControls` and a fresh `bringIntoView`, which together keep
 * the next measurement about hit rectangles rather than about layout.
 */
async function closeControlProperties(page: Page): Promise<void> {
  await callApi(page, "closeTaskPane", [CONTROL_PROPERTIES_PANE]).catch(() => undefined);
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// The surfaces on screen
// ---------------------------------------------------------------------------

function embedSurface(page: Page, placementId: string) {
  return page.locator(`[data-script-embed="${placementId}"]`);
}
function embedBand(page: Page) {
  return page.locator("[data-script-embed-band]");
}
function embedWidget(page: Page, name: string) {
  return page.locator(`[data-script-embed] [data-form-widget="${name}"]`);
}
function embedOrphanNotice(page: Page) {
  return page.locator("[data-script-embed-orphan]");
}
function shapeFrame(page: Page, instanceId: string) {
  return page.locator(`iframe[data-shape-overlay="${instanceId}"]`);
}
function hitShims(page: Page, instanceId: string) {
  return page.locator(`[data-shape-hit-region="${instanceId}"]`);
}
function hitOutlines(page: Page, instanceId: string) {
  return page.locator(`[data-shape-hit-outline="${instanceId}"]`);
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

async function listPlacements(page: Page): Promise<Placement[]> {
  return callApp<Placement[]>(page, PLACEMENTS, "listEmbeddedFormPlacements");
}

async function placementById(page: Page, id: string): Promise<Placement | null> {
  return callApp<Placement | null>(page, PLACEMENTS, "getEmbeddedFormPlacement", [id]);
}

async function paneRowFor(page: Page, scriptId: string): Promise<PaneSummary | null> {
  const rows = await callApi<PaneSummary[]>(page, "listScriptPanes");
  return rows.find((r) => r.scriptId === scriptId) ?? null;
}

async function heldState(page: Page): Promise<HeldState> {
  return callApp<HeldState>(page, CODE_INVENTORY, "getScriptHeldState");
}

/** Place a form on the sheet — the USER's act. Nothing a script can call
 *  reaches this function, which is exactly why an embedded session needs no
 *  rate bucket at its entry the way `pane.dock` does. */
async function placeForm(page: Page, rig: Rig, scriptId: string): Promise<Placement> {
  return callApp<Placement>(page, PLACEMENTS, "placeEmbeddedForm", [
    {
      scriptId,
      sheetIndex: rig.sheetIndex,
      anchorRow: FORM_ANCHOR.row,
      anchorCol: FORM_ANCHOR.col,
    },
  ]);
}

// ===========================================================================

test.describe("On the grid — the control menu, declared hit rectangles, and an embedded form", () => {
  let rig: Rig | null = null;

  test.afterEach(async ({ sharedPage: page }) => {
    await installAppImport(page).catch(() => undefined);
    // Placements first (they close their own sessions), then the pane registry,
    // then the hit-region store, then the objects, then the scripts. A surface
    // left painted is a `pointer-events: auto` box over the NEXT spec's cells,
    // and a control left behind occupies an anchor the next test needs.
    await removeEveryPlacement(page);
    await callApi(page, "resetScriptPanes").catch(() => undefined);
    await callApp(page, SHAPE_HIT_REGIONS, "resetShapeHitRegions").catch(() => undefined);
    // The sheet's ROW GEOMETRY, before anything else that reads a cell: a delete
    // this file made and did not get to undo has moved every row below it for
    // the whole shared page (see `pendingRowRepairs`).
    await repairRowGeometry(page);
    await callApi(page, "setDesignMode", [false]).catch(() => undefined);
    await callApi(page, "closeTaskPane", [CONTROL_PROPERTIES_PANE]).catch(() => undefined);
    if (rig) {
      for (const controlId of rig.controlIds) await deleteControl(page, controlId);
      for (const scriptId of rig.scriptIds) await unmountScript(page, scriptId);
      rig = null;
    }
    await clearPatch(page);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("grid:refresh"));
    });
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }
  });

  // =========================================================================
  // 1. M3a — the control's own right-click menu, and what it must NOT do
  // =========================================================================
  test("right-clicking a control opens ITS menu with only the items that apply, a bare cell still opens the grid's menu, and the right-click does not run the button's script", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => {
      rig = r;
    });

    // ---- The two objects: one button (no Flip, no Edit Script) and one shape
    // (both). The OMIT rule is the half of M3a a unit test cannot see, because
    // "omitted" only means anything against a menu that is actually on screen.
    const buttonId = await createButtonControl(page, BUTTON_ANCHOR, rig.sheetIndex, `E2E Btn ${rig.uniq}`);
    rig.controlIds.push(buttonId);
    const shapeId = await createShapeControl(page, SHAPE_ANCHOR, rig.sheetIndex, `E2E Shape ${rig.uniq}`);
    rig.controlIds.push(shapeId);

    const buttonScriptId = `e2e-grid-button-${rig.uniq}`;
    rig.scriptIds.push(buttonScriptId);
    await mountScript(
      page,
      {
        id: buttonScriptId,
        name: `E2E Button Script ${rig.uniq}`,
        objectType: "button",
        instanceId: buttonId,
        source: buttonSource(),
        accessLevel: "unlocked",
        declaredCapabilities: [],
      },
      ["clicks"],
    );

    await bringIntoView(page, BUTTON_ANCHOR.row, BUTTON_ANCHOR.col);
    const buttonBox = await waitForControlPainted(page, buttonId);

    // ---- (a) THE MENU OPENS AT ALL. Before M3a, fifteen items were registered
    // into `gridExtensions` and NOTHING rendered them: Core deliberately emits
    // no CONTEXT_MENU_REQUEST for a right-click on a floating object.
    await page.mouse.click(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2, {
      button: "right",
    });
    const menu = page.locator(CONTROL_MENU);
    await expect(menu, "a right-click on a button must open the CONTROL's own menu").toBeVisible({
      timeout: 10_000,
    });
    // Host chrome: the menu is titled with what the user calls the object.
    await expect(menu).toContainText("Button");
    // ...and the GRID's cell menu is NOT up. Two menus for one right-click would
    // mean Core's `defaultPrevented` check never saw the listener's preventDefault.
    await expect(page.locator(GRID_MENU), "the cell menu must stand down over an object").toHaveCount(0);

    // ---- (b) WHAT APPLIES, AND ONLY WHAT APPLIES.
    for (const id of ["controls.duplicate", "controls.copy", "controls.order", "controls.delete"]) {
      await expect(menu.locator(`[data-control-menu-item="${id}"]`), `a button offers ${id}`).toHaveCount(1);
    }
    for (const id of ["controls.flipH", "controls.flipV", "controls.editScript", "controls.applyTemplate"]) {
      await expect(
        menu.locator(`[data-control-menu-item="${id}"]`),
        `${id} means nothing for a button and must be OMITTED, not greyed`,
      ).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0, { timeout: 5_000 });

    // ---- (c) THE SAME MENU FOR A SHAPE CARRIES THE FOUR THE BUTTON DID NOT.
    // The positive control for (b): without it, "absent" would pass just as well
    // against a menu builder that emits those four for nobody.
    await bringIntoView(page, SHAPE_ANCHOR.row, SHAPE_ANCHOR.col);
    const shapeBox = await waitForControlPainted(page, shapeId);
    await page.mouse.click(shapeBox.left + shapeBox.width / 2, shapeBox.top + shapeBox.height / 2, {
      button: "right",
    });
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu).toContainText("Shape");
    for (const id of ["controls.flipH", "controls.flipV", "controls.editScript", "controls.applyTemplate"]) {
      await expect(menu.locator(`[data-control-menu-item="${id}"]`), `a shape offers ${id}`).toHaveCount(1);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0, { timeout: 5_000 });
    // A right-click on a shape also SELECTS it, which opens the
    // control-properties task pane and narrows the grid; put it away before the
    // next measurement so no coordinate below is stale.
    await deselectControls(page);
    await closeControlProperties(page);

    // ---- (d) A BARE CELL STILL BELONGS TO THE GRID. The listener is on
    // `window` and sees every right-click in the app, so the one thing it must
    // never do is answer for a click that landed on nothing.
    await bringIntoView(page, BARE_CELL.row, BARE_CELL.col);
    const bare = await cellClientPoint(page, BARE_CELL.ref);
    expect(
      await controlUnderPoint(page, bare.x, bare.y),
      `${BARE_CELL.ref} must be bare — the product's own hit test says otherwise`,
    ).toBeNull();
    await page.mouse.click(bare.x, bare.y, { button: "right" });
    await expect(page.locator(GRID_MENU), "a bare cell still opens the SHELL's cell menu").toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(CONTROL_MENU), "...and not the control's").toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(GRID_MENU)).toHaveCount(0, { timeout: 5_000 });

    // ---- (e) THE MACRO. `installControlObjectMenu` selects the clicked control
    // by calling `selectFloatingControl` directly rather than dispatching
    // `floatingObject:selected`, BECAUSE that event's handler runs a button's
    // script in run mode. This asserts the promise end to end.
    //
    // The POSITIVE CONTROL runs first: a LEFT click must reach the script, or
    // "it never ran" below would pass against a recorder that never works.
    const clicksNow = (): Promise<number> => callExposed<number>(page, "button", buttonId, "clicks");

    // The right-click in step (a) landed on THIS button. Nothing should have
    // reached the script from it, and the count is read here — before any left
    // click muddies it — so the two right-clicks are measured separately.
    expect(
      await clicksNow(),
      "the right-click in step (a) opened this button's menu and must have run NOTHING",
    ).toBe(0);

    await bringIntoView(page, BUTTON_ANCHOR.row, BUTTON_ANCHOR.col);
    const clickBox = await waitForControlPainted(page, buttonId);
    const centre = { x: clickBox.left + clickBox.width / 2, y: clickBox.top + clickBox.height / 2 };
    const beforeLeft = await clicksNow();
    await page.mouse.click(centre.x, centre.y);
    await expect
      .poll(clicksNow, {
        timeout: 15_000,
        message: "a plain left click on a run-mode button must reach its object script's onClick",
      })
      .toBe(beforeLeft + 1);
    const afterLeft = beforeLeft + 1;

    await page.mouse.click(centre.x, centre.y, { button: "right" });
    await expect(menu, "the right-click still opens the object menu").toBeVisible({ timeout: 10_000 });
    // Give any click path that DOES fire time to arrive: an assertion that the
    // count is unchanged is only worth making after the racing path would have
    // landed. 1.5 s is far past the synchronous `button:clicked` emit.
    await page.waitForTimeout(1_500);
    expect(
      await clicksNow(),
      "A RIGHT-CLICK MUST NEVER FIRE A MACRO. If the count moved, the menu is not the " +
        "path that ran it: Core's `handleMouseDown` " +
        "(core/hooks/useMouseSelection/useMouseSelection.ts) has no `event.button` " +
        "filter, so a right MOUSEDOWN reaches `handleOverlayMoveMouseDown` " +
        "(layout/overlayMoveHandlers.ts), which dispatches `floatingObject:selected` " +
        "unconditionally — and Controls' handler emits `button:clicked` for a " +
        "run-mode button. The menu's own `selectForMenu` is innocent; the mousedown " +
        "that precedes the contextmenu event is not.",
    ).toBe(afterLeft);
    await page.keyboard.press("Escape");
  });

  // =========================================================================
  // 2. M3b — declared hit rectangles (`ui.htmlInput`) over a real `ui.html` frame
  // =========================================================================
  test("a shape's declared rectangle claims the pointer above its frame while undeclared pixels still reach the grid, Design Mode suspends and outlines the claim, and right-click is never claimed", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => {
      rig = r;
    });

    const shapeId = await createShapeControl(page, SHAPE_ANCHOR, rig.sheetIndex, `E2E Hit ${rig.uniq}`);
    rig.controlIds.push(shapeId);
    const shapeScriptId = `e2e-grid-shape-${rig.uniq}`;
    rig.scriptIds.push(shapeScriptId);
    await mountScript(
      page,
      {
        id: shapeScriptId,
        name: `E2E Shape Script ${rig.uniq}`,
        objectType: "shape",
        instanceId: shapeId,
        source: shapeSource(),
        accessLevel: "restricted",
        declaredCapabilities: ["ui.html", "ui.htmlInput"],
      },
      ["paint", "claim"],
    );

    await bringIntoView(page, SHAPE_ANCHOR.row, SHAPE_ANCHOR.col);
    await waitForControlPainted(page, shapeId);

    // ---- The frame. `updateHtmlOverlay` only runs for a shape that HAS html,
    // so the claim has nothing to sit on until the script paints one.
    await callExposed(page, "shape", shapeId, "paint");
    const frame = shapeFrame(page, shapeId);
    await expect(frame, "render.setHtml must produce a real iframe over the canvas").toBeVisible({
      timeout: 15_000,
    });
    // ...and it is INERT, in both modes and for the life of the element. This is
    // the keyboard half of the input gate, and the half `pointer-events: none`
    // never covered: an iframe keeps its place in the sequential focus order
    // however it is styled, so Tab walked off the grid into the script's own
    // document and a `ui.html`-only script's `<input>` read what was typed. On
    // this host a claim buys SYNTHESIZED pointer messages and never focus, which
    // is what lets ui.htmlInput promise "pointer input only: there is no key
    // stream" — so unlike the pane card, nothing here ever takes it back off.
    // Asserted in a real browser because jsdom carries the attribute without
    // implementing what it means.
    await expect(
      frame,
      "the on-grid script frame must be inert, or Tab reaches the script's page",
    ).toHaveAttribute("inert", "");
    // EVERY POINT IS RE-MEASURED, never cached. A click that selects the shape
    // opens the control-properties task pane, and a sidebar appearing narrows
    // the grid — so a coordinate taken before such a click is wrong after it.
    const framePoint = async (fx: number, fy: number): Promise<{ x: number; y: number }> => {
      const box = await shapeFrame(page, shapeId).boundingBox();
      expect(box, "the shape's html frame reports no box").not.toBeNull();
      return { x: box!.x + fx, y: box!.y + fy };
    };
    /** The centre of the rectangle the script claims (or will claim). */
    const claimCentre = (): Promise<{ x: number; y: number }> =>
      framePoint(CLAIM.x + CLAIM.width / 2, CLAIM.y + CLAIM.height / 2);
    /** A pixel of the frame the script never claims — bottom-right corner area. */
    const gapPoint = async (): Promise<{ x: number; y: number }> => {
      const box = await shapeFrame(page, shapeId).boundingBox();
      return { x: box!.x + box!.width - 24, y: box!.y + box!.height - 24 };
    };

    // ---- (a) NOTHING DECLARED = FULLY CLICK-THROUGH, exactly as before M3b.
    // This is the same state a release returns the frame to, so it is asserted
    // here rather than by building a second shape that declares nothing.
    await expect(hitShims(page, shapeId), "an undeclared frame claims nothing").toHaveCount(0);
    await deselectControls(page);
    const preClaim = await claimCentre();
    await page.mouse.click(preClaim.x, preClaim.y);
    await expect
      .poll(async () => isControlSelected(page, shapeId), {
        timeout: 10_000,
        message:
          "with nothing declared, a click anywhere in the frame must fall through to the grid, " +
          "which selects the shape underneath",
      })
      .toBe(true);
    await deselectControls(page);
    await closeControlProperties(page);
    await bringIntoView(page, SHAPE_ANCHOR.row, SHAPE_ANCHOR.col);

    // ---- (b) THE CLAIM. One rectangle, frame-local, inside the bounds
    // `shapeHitRegionSpec.ts` sets (16 rectangles, ids `[A-Za-z0-9_.:-]`,
    // coordinates 0..20000, minimum edge 1).
    await callExposed(page, "shape", shapeId, "claim", [[CLAIM]]);
    await expect(hitShims(page, shapeId), "one declared rectangle, one shim").toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(hitShims(page, shapeId)).toHaveAttribute("data-hit-region-id", CLAIM.id);

    // The shim is placed in the FRAME's own space — the host adds the frame's
    // canvas origin, and the script never learns it.
    const frameBox = await shapeFrame(page, shapeId).boundingBox();
    const shimBox = await hitShims(page, shapeId).boundingBox();
    expect(shimBox, "the shim reports no box").not.toBeNull();
    expect(Math.round(shimBox!.x - frameBox!.x)).toBe(CLAIM.x);
    expect(Math.round(shimBox!.y - frameBox!.y)).toBe(CLAIM.y);
    expect(Math.round(shimBox!.width)).toBe(CLAIM.width);
    expect(Math.round(shimBox!.height)).toBe(CLAIM.height);

    // THE Z-ORDER, which is the whole mechanism and has no oracle below a real
    // browser: the shim (z-index 6) is what the pointer meets, ABOVE the opaque
    // iframe (z-index 5) it belongs to.
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-shape-hit-region") ?? null,
        await claimCentre(),
      ),
      "the topmost element over a declared rectangle must be that rectangle's shim",
    ).toBe(shapeId);

    // ---- (c) A CLICK INSIDE THE RECTANGLE IS CLAIMED. The shim stops the
    // event, so the grid never sees it: the shape is NOT selected and the cell
    // selection does not move.
    const refBefore = await selectedRef(page);
    const claimed = await claimCentre();
    await page.mouse.click(claimed.x, claimed.y);
    await page.waitForTimeout(700);
    expect(
      await isControlSelected(page, shapeId),
      "A CLICK ON A DECLARED RECTANGLE BELONGS TO THE SCRIPT'S FRAME, NOT TO THE GRID. " +
        "If the shape came back selected, the shim did not actually take the gesture: it " +
        "stops `pointerdown` and `click` (Shape/shapeHitRegions.ts, `createShim`), and Core " +
        "listens for `mousedown` — on `S.GridArea` " +
        "(core/components/Spreadsheet/Spreadsheet.tsx `onMouseDown={wrappedMouseDown}`), an " +
        "ANCESTOR of the canvas parent the shim is appended to, so the native mousedown " +
        "bubbles straight past it into `handleOverlayMoveMouseDown`, whose `checkOverlayBody` " +
        "is pure geometry and whose target guard only spares INPUT/TEXTAREA/SELECT. The " +
        "module's own comment (\"the canvas is a SIBLING, so it never sees this event\") is " +
        "true of the canvas and beside the point: the handler is not on the canvas.",
    ).toBe(false);
    expect(await selectedRef(page), "...and it moved no cell selection either").toBe(refBefore);

    // ---- (d) AN UNDECLARED PIXEL STILL REACHES THE GRID. What "the grid got
    // it" means over a SHAPE is that Core's own pointer path ran and selected
    // the object — a shape's box is not a cell, so there is no cell selection
    // for a click INSIDE the shape to move (see this file's `deviations` note).
    // The cell-selection half of the claim is asserted immediately below, on a
    // pixel that is genuinely bare.
    const gap = await gapPoint();
    await page.mouse.click(gap.x, gap.y);
    await expect
      .poll(async () => isControlSelected(page, shapeId), {
        timeout: 10_000,
        message: "an UNDECLARED pixel of the frame must fall through to Core's own pointer path",
      })
      .toBe(true);
    await deselectControls(page);
    await closeControlProperties(page);
    await bringIntoView(page, SHAPE_ANCHOR.row, SHAPE_ANCHOR.col);

    // ...and a pixel that is on no object at all moves the CELL selection —
    // the positive control for the click machinery itself, and what "reaches
    // the grid" looks like to a user.
    const bare = await cellClientPoint(page, BARE_BELOW_SHAPE.ref);
    expect(
      await controlUnderPoint(page, bare.x, bare.y),
      `${BARE_BELOW_SHAPE.ref} must be clear of the shape — the product's own hit test says otherwise`,
    ).toBeNull();
    await page.mouse.click(bare.x, bare.y);
    await expect.poll(async () => selectedRef(page), { timeout: 10_000 }).toBe(BARE_BELOW_SHAPE.ref);

    // ---- (e) RIGHT-CLICK IS NEVER CLAIMED. A script may legitimately cover its
    // whole frame; the shape's own menu has to stay reachable on top of the
    // claim, because that menu is how the user deletes the thing.
    const reInside = await claimCentre();
    await page.mouse.click(reInside.x, reInside.y, { button: "right" });
    await expect(
      page.locator(CONTROL_MENU),
      "the shape's own menu must open THROUGH a claimed rectangle — no shim listens for contextmenu",
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(page.locator(CONTROL_MENU)).toHaveCount(0, { timeout: 5_000 });

    // ---- (f) DESIGN MODE IS THE ESCAPE: every claim suspended at once, and the
    // rectangles OUTLINED so the user can see what was taken. Both halves are
    // decided from the same geometry, so they can never answer differently.
    await callApi(page, "setDesignMode", [true]);
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await expect(hitShims(page, shapeId), "Design Mode suspends every claim").toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(hitOutlines(page, shapeId), "...and shows what was claimed").toHaveCount(1, {
      timeout: 10_000,
    });
    const designFrame = await shapeFrame(page, shapeId).boundingBox();
    const outlineBox = await hitOutlines(page, shapeId).boundingBox();
    expect(Math.round(outlineBox!.x - designFrame!.x)).toBe(CLAIM.x);
    expect(Math.round(outlineBox!.width)).toBe(CLAIM.width);

    await callApi(page, "setDesignMode", [false]);
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await expect(hitShims(page, shapeId), "leaving Design Mode restores the claim").toHaveCount(1, {
      timeout: 10_000,
    });

    // ---- (g) THE RELEASE. An empty list gives the frame back — the same door
    // the host uses on unmount, so "released because the script asked" and
    // "released because the script is gone" cannot drift apart.
    await callExposed(page, "shape", shapeId, "claim", [[]]);
    await expect(hitShims(page, shapeId), "`[]` releases the frame").toHaveCount(0, { timeout: 10_000 });
    await expect(hitOutlines(page, shapeId), "and leaves no outline stranded").toHaveCount(0);
  });

  // =========================================================================
  // 3. M3c — the form on the sheet: one widget tree, one registry, one refusal
  // =========================================================================
  test("an embedded form paints the shared widget tree under its identity band, writes its bound cell TYPED, refuses pane.close, and appears in the inventory as placement \"embedded\"", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => {
      rig = r;
    });
    const sheetName = await activeSheetName(page);

    // Seed the bound cells TYPED, through the probe's realm — never through the
    // locale-sensitive entry ladder, which in sv-SE would type a decimal comma.
    await writeCell(page, rig, QTY, 7);
    await writeCell(page, rig, NOTE, "Seeded");

    const formScriptId = `e2e-grid-form-${rig.uniq}`;
    const formName = `E2E Embedded Form ${rig.uniq}`;
    rig.scriptIds.push(formScriptId);
    await mountScript(
      page,
      {
        id: formScriptId,
        name: formName,
        objectType: "form",
        instanceId: `${formScriptId}-instance`,
        source: formSource(),
        accessLevel: "restricted",
        declaredCapabilities: ["ui.pane"],
      },
      ["closeFromScript", "surfaces"],
    );
    const formInstance = `${formScriptId}-instance`;

    await bringIntoView(page, FORM_ANCHOR.row, FORM_ANCHOR.col);
    const placement = await placeForm(page, rig, formScriptId);
    expect(
      placement.id,
      "a placement's identity is MINTED, never derived from its anchor — that is the whole of M3c",
      // The canonical 8-4-4-4-12 shape, not "36 characters from [0-9a-f-]": the
      // loose form passes for a string of 36 hyphens, which is exactly the class
      // of derived-looking id this assertion exists to rule out.
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(placement.orphaned).toBe(false);

    const surface = embedSurface(page, placement.id);
    await expect(surface, "the placement's surface must paint on the sheet").toBeVisible({ timeout: 20_000 });

    // ---- THE BAND IS HOST CHROME. Every line is host-derived and the branch is
    // on the origin KIND, never on a name, so a script on the grid can never
    // present itself as Calcula or as another script.
    await expect(embedBand(page)).toContainText(formName);
    await expect(embedBand(page)).toContainText("A form on this sheet from a script in this workbook");
    await expect(embedBand(page)).toContainText(`Sheet: ${sheetName}`);
    // The script's own title is BODY content, below the band.
    await expect(page.locator("[data-script-embed-title]")).toHaveText("On-grid order");
    await expect(embedBand(page), "a script-supplied title never reaches the chrome").not.toContainText(
      "On-grid order",
    );
    // NO CLOSE AFFORDANCE, deliberately: the object belongs to the sheet and the
    // user removes it there. A close that took the surface down but left the
    // object would be two truths in one document.
    await expect(page.locator("[data-script-embed] [data-script-pane-close]")).toHaveCount(0);

    // ---- THE SAME WIDGET TREE. `data-form-widget` is the hook the modal and
    // the pane publish too, because all three paint ONE `FormWidgetTree`.
    await expect(embedWidget(page, "qty")).toHaveValue("7");
    await expect(embedWidget(page, "note")).toHaveValue("Seeded");

    // ---- A BOUND WIDGET WRITES THE TYPED VALUE BACK. There is no Submit on
    // this surface (`writeOn: "change"` for every bound name), so the write
    // happens on the change itself. The click is a REAL mouse click on the card:
    // the surface is a nested React root inside the grid's own DOM, and this is
    // where a stolen mousedown would show up.
    const qty = embedWidget(page, "qty");
    await qty.click();
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute("data-form-widget") ?? null,
      ),
      "A CLICK ON A WIDGET OF AN ON-GRID FORM MUST FOCUS THAT WIDGET. If it did not, the " +
        "grid's own mousedown took the click: the surface's host element carries no " +
        "`mousedown` guard (lib/embeddedFormLayer.ts, `ensureHost`) and it is a DESCENDANT " +
        "of `S.GridArea`, whose `onMouseDown` runs `handleCellMouseDown` " +
        "(core/hooks/useMouseSelection/selection/cellSelectionHandlers.ts) — which calls " +
        "`event.preventDefault()` before any await and so cancels the browser's focus, with " +
        "no INPUT/TEXTAREA exemption anywhere on that path (the one that exists is inside " +
        "`handleOverlayMoveMouseDown`, which this region never reaches because it publishes " +
        "no `floating` box)",
    ).toBe("qty");
    await qty.fill("42");
    await expect
      .poll(async () => (await readCell(page, rig!, QTY)).value, { timeout: 15_000 })
      .toBe(42);
    const written = await readCell(page, rig, QTY);
    expect(written.type, `qty landed as ${JSON.stringify(written)} — a number widget writes a NUMBER`).toBe(
      "number",
    );

    // ---- THE REGISTRY. An embedded surface is a pane SESSION, not a fourth
    // registry, and it says so.
    // POLLED, not read once: a session's `placement` is stamped by `markDocked`,
    // which runs on the renderer's own acknowledgement — a separate turn from the
    // REQUEST event that built the store and got the surface painted above. A bare
    // read here would be a race the surface's visibility does not settle.
    await expect
      .poll(async () => (await paneRowFor(page, formScriptId))?.placement ?? null, {
        timeout: 15_000,
        message: "the session's placement is the host's answer, never the renderer's",
      })
      .toBe("embedded");
    const row = await paneRowFor(page, formScriptId);
    expect(row?.boundCells, "both bound widgets are CELL bindings").toBe(2);

    // ---- `pane.close` IS REFUSED. A docked pane is a thing the script asked
    // for, so it may give it back; a form embedded on a sheet is an object the
    // USER placed in their document. The call is fire-and-forget, so the audit
    // ring and the surface still standing are the evidence.
    const before = await auditTally(page, formScriptId, "pane.close");
    await callExposed(page, "form", formInstance, "closeFromScript");
    await expect
      .poll(async () => (await auditTally(page, formScriptId, "pane.close")).refused, {
        timeout: 15_000,
        message: "the script's pane.close must be REFUSED and the refusal recorded under its name",
      })
      .toBe(before.refused + 1);
    expect(
      (await auditTally(page, formScriptId, "pane.close")).errors,
      "the refusal is a HostError — a BrokerError's code is what the ring records",
    ).toContain("HostError");
    await page.waitForTimeout(700);
    await expect(surface, "the surface the USER placed is still on the sheet").toBeVisible();
    expect((await paneRowFor(page, formScriptId))?.placement).toBe("embedded");

    // ...and the script can still see and drive it, which is what the refusal's
    // own sentence promises ("Use pane.update(...) to change what it shows").
    const surfaces = await callExposed<Array<{ embedded: boolean; placement: string | null }>>(
      page,
      "form",
      formInstance,
      "surfaces",
    );
    expect(surfaces.length, "pane.list is filtered to the caller and holds its one surface").toBe(1);
    expect(surfaces[0].embedded).toBe(true);
    expect(surfaces[0].placement).toBe("embedded");

    // ---- TRANSPARENCY. The panel must be able to say WHERE a script's surface
    // is, or "which mechanisms is this script using" is only half answered.
    const state = await heldState(page);
    const held = state.panes.find((p) => p.scriptId === formScriptId);
    expect(held, `the embedded form must be in getScriptHeldState(): ${JSON.stringify(state.panes)}`)
      .toBeDefined();
    expect(held?.placement).toBe("embedded");
    expect(held?.embedded, "read off the registry's own record, not derived from `placement`").toBe(true);
    expect(held?.placementId).toBe(placement.id);
    expect(held?.ownerName, "the owner is JOINED, never taken from the script's own claim").toBe(formName);
    expect(held?.ownerMissing).toBe(false);
    expect(held?.boundCells).toBe(2);

    const summary = await callApp<HeldSummary>(page, CODE_INVENTORY, "summarizeScriptHeldState", [state]);
    expect(summary.embeddedForms, "the header chip counts an on-grid form separately from a task pane").toBe(
      1,
    );
    expect(summary.forms, "an embedded form is not a modal form").toBe(0);
  });

  // =========================================================================
  // 4. M3c — the identity model: a structural edit MOVES it, a deleted anchor
  //    ORPHANS it, and the orphan names a gesture that exists
  // =========================================================================
  test("a structural edit moves an embedded placement without re-keying it, and deleting its anchor row orphans it visibly with a remedy the grid menu really offers", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => {
      rig = r;
    });

    const formScriptId = `e2e-grid-form-id-${rig.uniq}`;
    rig.scriptIds.push(formScriptId);
    await mountScript(
      page,
      {
        id: formScriptId,
        name: `E2E Placement ${rig.uniq}`,
        objectType: "form",
        instanceId: `${formScriptId}-instance`,
        source: formSource(),
        accessLevel: "restricted",
        declaredCapabilities: ["ui.pane"],
      },
      ["closeFromScript", "surfaces"],
    );

    await bringIntoView(page, FORM_ANCHOR.row, FORM_ANCHOR.col);
    const placed = await placeForm(page, rig, formScriptId);
    await expect(embedSurface(page, placed.id)).toBeVisible({ timeout: 20_000 });
    // POLLED, not read once. The surface PAINTS on the REQUEST event, but the
    // registry only records the session when the renderer acknowledges it —
    // a later turn. A bare read here passed when this file ran alone and failed
    // in a full journey run at 2.4 s, which is the signature of a race, not of
    // a missing session (test 3 already polls the same registry for the same
    // reason).
    await expect
      .poll(async () => (await paneRowFor(page, formScriptId))?.paneId ?? null, {
        timeout: 15_000,
        message: "the embedded form never registered a live session",
      })
      .not.toBeNull();
    const paneIdBefore = (await paneRowFor(page, formScriptId))?.paneId;
    expect(paneIdBefore, "a live session before the structural edit").toBeTruthy();

    // ---- (a) AN INSERT MOVES THE ANCHOR AND NOTHING ELSE. With an
    // anchor-derived id this was a RENAME: every id-keyed side table had to be
    // told, and `reanchorFloatingControls`' `onRename` hook exists only for that.
    // Two rows, inserted well above, through `@api`'s own `insertRows` — the
    // function the ribbon calls, and the one that emits ROWS_INSERTED.
    const insertAt = FORM_ANCHOR.row - 7;
    await insertRowsTracked(page, insertAt, 2);
    await expect
      .poll(async () => (await placementById(page, placed.id))?.anchorRow ?? -1, {
        timeout: 15_000,
        message: "the insert never reached the placement store",
      })
      .toBe(FORM_ANCHOR.row + 2);
    const moved = await placementById(page, placed.id);
    expect(moved?.id, "the identity is untouched by a structural edit").toBe(placed.id);
    expect(moved?.orphaned, "an insert never orphans anything").toBe(false);
    expect(moved?.anchorCol, "a row insert moves rows only").toBe(FORM_ANCHOR.col);
    expect(
      (await paneRowFor(page, formScriptId))?.paneId,
      "no consumer re-keys, so the SESSION painting it carries on uninterrupted",
    ).toBe(paneIdBefore);
    await bringIntoView(page, FORM_ANCHOR.row + 2, FORM_ANCHOR.col);
    await expect(embedSurface(page, placed.id), "and the same surface is still painted").toBeVisible({
      timeout: 15_000,
    });

    // Put the sheet back the way it was found (and stop `afterEach` repeating it).
    await undoLastRowEdit(page);
    await expect
      .poll(async () => (await placementById(page, placed.id))?.anchorRow ?? -1, { timeout: 15_000 })
      .toBe(FORM_ANCHOR.row);
    expect((await placementById(page, placed.id))?.orphaned, "a delete ABOVE the anchor only shifts").toBe(
      false,
    );

    // ---- (b) A DELETED ANCHOR ORPHANS, NEVER DROPS. `reanchorFloatingControls`
    // deletes a control whose row goes and tells nobody; a placement keeps the
    // record so the user can see what happened to their layout.
    await bringIntoView(page, FORM_ANCHOR.row, FORM_ANCHOR.col);
    await deleteRowsTracked(page, FORM_ANCHOR.row, 1);
    await expect
      .poll(async () => (await placementById(page, placed.id))?.orphaned ?? null, {
        timeout: 15_000,
        message: "deleting the anchor row must ORPHAN the placement, not delete it",
      })
      .toBe(true);
    expect(
      (await listPlacements(page)).some((p) => p.id === placed.id),
      "the record survives: dropping it would take the user's layout with it",
    ).toBe(true);
    // The session ends — its bindings would otherwise resolve against whatever
    // now occupies those coordinates.
    await expect
      .poll(async () => paneRowFor(page, formScriptId), { timeout: 15_000 })
      .toBeNull();

    // ---- (c) THE ORPHAN IS VISIBLE, AND ITS SENTENCE NAMES A REAL GESTURE.
    // All three orphan sentences once told the user to drag the box onto a cell
    // and nothing in the app has ever been able to drag it; the remedy is now
    // ONE constant, quoted here from the module that owns it.
    await bringIntoView(page, FORM_ANCHOR.row, FORM_ANCHOR.col);
    const orphan = embedOrphanNotice(page);
    await expect(orphan, "an orphaned placement paints a card that says what happened").toBeVisible({
      timeout: 20_000,
    });
    const remedy = await readConst<string>(page, PLACEMENTS, "EMBEDDED_FORM_ORPHAN_REMEDY");
    expect(
      remedy,
      "the remedy must not have gone back to naming a drag: nothing in the app can drag this box " +
        "(Core's move path returns early on `!hit.region.floating`, and this region publishes none)",
    ).not.toMatch(/drag/i);
    expect(remedy).toContain(RESTORE_LABEL);
    expect(remedy).toContain(REMOVE_LABEL);
    expect(await readConst<string>(page, PLACEMENTS, "EMBEDDED_FORM_RESTORE_MENU_LABEL")).toBe(RESTORE_LABEL);
    expect(await readConst<string>(page, PLACEMENTS, "EMBEDDED_FORM_REMOVE_MENU_LABEL")).toBe(REMOVE_LABEL);
    await expect(orphan).toContainText("the cell it was anchored to was deleted");
    await expect(orphan, "the card reads the same constant, not a third spelling").toContainText(remedy);

    // ---- (d) AND THE GESTURE REALLY OPENS. This is the assertion the sentence
    // depends on and the one nothing below e2e can make: the orphan card is an
    // opaque `pointer-events: auto` element sitting ON the anchor cell, and the
    // remedy tells the user to RIGHT-CLICK that cell. It works only because the
    // card installs no `contextmenu` handler AND the region it publishes has no
    // `floating` box — so Core's `findFloatingRegionAt` early-return does not
    // fire and the cell menu opens through the card. The day somebody adds a
    // `floating` box to make the box draggable, this goes red.
    const anchorPoint = await cellCornerPoint(page, FORM_ANCHOR.ref, 6, 6);
    await page.mouse.click(anchorPoint.x, anchorPoint.y, { button: "right" });
    const gridMenu = page.locator(GRID_MENU);
    await expect(
      gridMenu,
      "the orphan's card must not eat the right-click its own sentence asks for",
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      gridMenu,
      `the menu the remedy names must actually offer "${RESTORE_LABEL}"`,
    ).toContainText(RESTORE_LABEL);
    await expect(gridMenu).toContainText(REMOVE_LABEL);
    await page.keyboard.press("Escape");
    await expect(gridMenu).toHaveCount(0, { timeout: 5_000 });

    // Put the row back so the sheet's geometry leaves as it arrived. `afterEach`
    // does the same for every path that does not reach this line.
    await undoLastRowEdit(page);
    await page.waitForTimeout(300);
  });
});
