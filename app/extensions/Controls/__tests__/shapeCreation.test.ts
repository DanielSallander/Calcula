//! FILENAME: app/extensions/Controls/__tests__/shapeCreation.test.ts
// PURPOSE: Pin the SHAPE recipe — the seventeen property keys, the three
//          load-bearing ones, the two refusals, and the two pre-existing defects
//          fixed alongside it (an orphaned object script on delete, and controls
//          never reloading when the active sheet changes).
// CONTEXT: A shape is not one write. It is backend metadata with the RIGHT
//          property names, a pixel WALK over irregular column widths and row
//          heights, registration in the floating store, a cache invalidate and
//          an overlay re-sync — and every one of those can be missed while the
//          backend reports success and the grid stays empty. That failure has
//          shipped here before (the Macro Recorder's `{ label }` button), which
//          is why the recipe lives in ONE function and why its contents are
//          asserted rather than reviewed.
//
//          Some assertions read the extension SOURCE. That is deliberate and
//          matches `imageIngress.test.ts` / `mediaHandles.test.ts`: importing
//          `index.ts` would drag in React, the whole @api facade and the grid
//          overlay system to prove a property of a fifty-line function. What is
//          BEHAVIOURAL here (the catalog, the id round-trip, the store) is
//          tested by running it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { getShapeCategories, getShapeDefinition } from "../Shape/shapeCatalog";
import { SHAPE_PROPERTIES } from "../Shape/shapeProperties";
import { makeFloatingControlId, parseFloatingControlId } from "../lib/floatingStore";

const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");

/** The body of one top-level `async function <name>(` in the extension source. */
function functionBody(name: string): string {
  const start = INDEX_SRC.indexOf(`async function ${name}(`);
  expect(start, `${name} not found in Controls/index.ts`).toBeGreaterThan(-1);
  const open = INDEX_SRC.indexOf("{", INDEX_SRC.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < INDEX_SRC.length; i++) {
    if (INDEX_SRC[i] === "{") depth++;
    else if (INDEX_SRC[i] === "}") {
      depth--;
      if (depth === 0) return INDEX_SRC.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

// ============================================================================
// 1. The catalog is real, complete and discoverable
// ============================================================================

describe("the shape catalog", () => {
  const categories = getShapeCategories();
  const shapes = categories.flatMap((c) => c.shapes);

  it("holds 123 shapes in 8 categories", () => {
    // Not a vanity count: this is the number that must NOT be spelled into a
    // consent string or a validator enum. If it changes, `listShapeCatalog()`
    // still answers correctly and this test is the only thing to update.
    expect(categories).toHaveLength(8);
    expect(shapes).toHaveLength(123);
  });

  it("gives every shape a unique id, and getShapeDefinition finds every one", () => {
    const ids = shapes.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(getShapeDefinition(id), id).not.toBeNull();
  });

  it("spells every id the way the broker validator accepts", () => {
    // vCreateShape's SHAPE_TYPE_RE. The validator is stateless by contract and
    // cannot import this catalog (the Facade Rule runs both ways), so the two
    // are kept honest here instead of by a shared constant.
    const SHAPE_TYPE_RE = /^[a-z][A-Za-z0-9]*$/;
    for (const s of shapes) expect(SHAPE_TYPE_RE.test(s.id), s.id).toBe(true);
  });

  it("gives every shape a positive default size, so an option-less create has one", () => {
    for (const s of shapes) {
      expect(s.defaultWidth, s.id).toBeGreaterThan(0);
      expect(s.defaultHeight, s.id).toBeGreaterThan(0);
    }
  });

  it("returns null — not a fallback shape — for an id it does not hold", () => {
    expect(getShapeDefinition("notAShape")).toBeNull();
  });
});

// ============================================================================
// 2. The recipe: seventeen keys, and the three that are load-bearing
// ============================================================================

describe("createShapeControlAt writes the whole shape", () => {
  const body = functionBody("createShapeControlAt");

  const REQUIRED_KEYS = [
    "shapeType", "fill", "stroke", "strokeWidth",
    "text", "textColor", "fontSize", "fontBold", "fontItalic", "textAlign",
    "opacity", "rotation", "pinToGrid",
    "x", "y", "width", "height",
  ];

  it("writes all seventeen property keys", () => {
    expect(REQUIRED_KEYS).toHaveLength(17);
    for (const key of REQUIRED_KEYS) {
      expect(body, `missing property "${key}"`).toContain(`${key}: { valueType: "static"`);
    }
  });

  it("writes pinToGrid EXPLICITLY as \"false\"", () => {
    // `moves_with_cells` (controls.rs) defaults an ABSENT pin property to TRUE,
    // which is right for in-cell controls and wrong for every floating one. Omit
    // it and the backend shifts the anchor on the first row insert while the
    // frontend holds its pixels — divergence on the very first structural edit,
    // with nothing reported.
    expect(body).toContain('pinToGrid: { valueType: "static", value: "false" }');
  });

  it("spells the caption `text`, never `label`", () => {
    // The original invisible-control bug: `label` WRITES SUCCESSFULLY and draws
    // an empty shape, so the failure looks exactly like a rendering problem.
    expect(body).toContain("text: { valueType: \"static\", value: request.text");
    expect(body).not.toMatch(/\blabel:\s*\{/);
  });

  it("derives x/y from cellOriginPixels — a WALK, never a multiplication", () => {
    expect(body).toContain("cellOriginPixels(row, col)");
    expect(body).not.toMatch(/col\s*\*\s*default/);
    expect(body).not.toMatch(/row\s*\*\s*default/);
  });

  it("registers in the floating store, invalidates the cache and re-syncs the overlay", () => {
    expect(body).toContain("addFloatingControl(");
    // The ribbon path OMITTED this: the shape renderer caches its bitmap by
    // control id, so a fresh shape at an id a deleted one held repainted the
    // OLD shape.
    expect(body).toContain("invalidateShapeCache(controlId)");
    expect(body).toContain("syncFloatingControlRegions()");
    expect(body).toContain("AppEvents.GRID_REFRESH");
  });

  it("returns a handle carrying the instanceId, so no caller re-derives it", () => {
    expect(body).toContain("instanceId: controlId");
  });

  it("THROWS on an unknown shape id, naming the accepted ids", () => {
    expect(body).toMatch(/if \(!shapeDef\) \{[\s\S]*throw new Error\(/);
    expect(body).toContain("listShapeCatalogEntries().map((s) => s.id)");
    // The old behaviour, which a caller cannot tell apart from "it drew nothing".
    expect(body).not.toMatch(/if \(!shapeDef\) return;/);
  });

  it("REFUSES an occupied anchor instead of overwriting it", () => {
    // `set_control_metadata` is a plain map insert. Creating over an occupied
    // cell wipes the existing control — and because an instanceId is derived
    // from the ANCHOR, the wiped control's object script stays bound to that id
    // for the newcomer to inherit.
    expect(body).toContain("getControlMetadata(sheetIndex, row, col)");
    expect(body).toMatch(/if \(occupant\) \{[\s\S]*throw new Error\(/);
  });

  it("only writes `name` when one was asked for", () => {
    // `listControls` reads this property for the object list; writing "" would
    // name every shape "".
    expect(body).toContain('...(request.name ? { name: { valueType: "static", value: request.name } } : {})');
  });
});

describe("insertShape is a caller of the recipe, not a second copy of it", () => {
  const body = functionBody("insertShape");

  it("delegates to createShapeControlAt", () => {
    expect(body).toContain("createShapeControlAt({");
  });

  it("writes no control metadata of its own", () => {
    expect(body).not.toContain("setControlMetadata(");
    expect(body).not.toContain("addFloatingControl(");
  });

  it("SHOWS a refusal, because the menu calls it unawaited", () => {
    expect(body).toContain("showToast(");
    expect(body).toMatch(/catch \(err\)/);
  });
});

// ============================================================================
// 3. `name` has a writer now that it has a reader
// ============================================================================

describe("the shape `name` property", () => {
  it("is editable in the Properties pane", () => {
    // It had a READER (`listControls` -> api.listObjects("shape")) and no
    // writer anywhere, so the object list showed a name column that was always
    // "" and could never be changed. `api.createShape(..., { name })` writes it,
    // so the pane must be able to change it.
    const def = SHAPE_PROPERTIES.find((p) => p.key === "name");
    expect(def, "SHAPE_PROPERTIES has no `name` row").toBeDefined();
    expect(def!.inputType).toBe("text");
    expect(def!.readOnly).toBeUndefined();
  });
});

// ============================================================================
// 4. Defect: a control's object script was ORPHANED on delete
// ============================================================================

describe("deleteFloatingControl tears down EVERY control type", () => {
  const body = functionBody("deleteFloatingControl");

  it("does not gate script cleanup on controlType === \"shape\"", () => {
    // The gate leaked the object script of every non-shape control. Because an
    // instanceId is derived from the ANCHOR, a button deleted at B3 left
    // `control-0-2-1`'s script behind and the NEXT control created at B3
    // silently inherited it — code its author never wrote, running on a click.
    expect(body).not.toMatch(/if \(ctrl\.controlType === "shape"\)/);
  });

  it("still performs the full teardown, unconditionally", () => {
    for (const call of [
      "deleteObjectScriptsForInstance(controlId)",
      "clearDeclaredProperties(controlId)",
      "removeCustomCanvasRenderer(controlId)",
      "removeShapeHtmlOverlay(controlId)",
      "unmarkShapeHasScript(controlId)",
      "removeControlMetadata(",
      "removeFloatingControl(controlId)",
    ]) {
      expect(body, call).toContain(call);
    }
  });
});

describe("the seam's delete routes to the full teardown", () => {
  const body = functionBody("deleteControlByInstanceId");

  it("calls deleteFloatingControl, never removeButtonControlAt", () => {
    // `removeButtonControlAt` is the button seam's ROLLBACK for a half-made
    // control: it skips script cleanup, declared properties, the HTML overlay,
    // the selection and the Properties pane. Using it to delete would leave
    // exactly the orphans this change exists to end.
    expect(body).toContain("deleteFloatingControl(instanceId)");
    expect(body).not.toContain("removeButtonControlAt(");
  });

  it("reports false for an unknown id rather than pretending it deleted one", () => {
    expect(body).toContain("return false");
  });

  it("does not call a control on ANOTHER SHEET an in-cell control", () => {
    // The floating store holds ONE sheet at a time, so an ordinary shape on a
    // sheet the user is not looking at is also absent from it. Answering that
    // caller "this is an in-cell control, clear the cell" is a confident wrong
    // answer to a question it never asked. The two are separated by the same
    // embedded predicate the loader uses, and the cross-sheet branch runs FIRST.
    expect(body).toContain("isEmbeddedControl(meta.controlType, meta.properties)");
    const crossSheetAt = body.indexOf("is not the sheet");
    const inCellAt = body.indexOf("is an in-cell");
    expect(crossSheetAt, "no cross-sheet refusal").toBeGreaterThan(-1);
    expect(inCellAt, "no in-cell refusal").toBeGreaterThan(-1);
    expect(crossSheetAt).toBeLessThan(inCellAt);
  });
});

describe("the embedded predicate has exactly one definition", () => {
  it("is asked by both the loader and the delete path, never re-spelled", () => {
    // If the store's inclusion rule and the delete refusal ever disagreed, a
    // control would be refused with a reason that does not describe it — and
    // nothing would say so. One function, two callers.
    expect(INDEX_SRC).toContain("function isEmbeddedControl(");
    const calls = INDEX_SRC.match(/isEmbeddedControl\(/g) ?? [];
    expect(calls.length, "definition + two call sites").toBe(3);
    // The open-coded form this replaced must not come back in the loader.
    expect(INDEX_SRC).not.toContain("const isEmbedded = entry.metadata.controlType");
  });
});

// ============================================================================
// 5. Defect: controls were loaded ONCE, for the sheet active at activation
// ============================================================================

describe("controls follow the document AND the active sheet", () => {
  it("subscribes to SHEET_CHANGED", () => {
    // The floating store held whatever sheet was active at activation, forever:
    // another sheet's controls never appeared, and the first sheet's kept
    // painting over every other sheet because `syncFloatingControlRegions` has
    // no sheet filter.
    expect(INDEX_SRC).toContain("AppEvents.SHEET_CHANGED, reloadForSheetChange");
  });

  it("still subscribes to AFTER_OPEN and AFTER_NEW", () => {
    expect(INDEX_SRC).toContain("[AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW] as const");
  });

  it("swaps the DEPARTING sheet out, which it has to remember", () => {
    // SHEET_CHANGED reports the sheet being switched TO, so the sheet whose
    // controls are in the store cannot be derived at that moment.
    expect(INDEX_SRC).toContain("loadedSheetIndex = sheetIndex");
    expect(INDEX_SRC).toContain("removeFloatingControlsForSheet(loadedSheetIndex)");
  });

  it("puts the STARTUP load on the same queue as the two reloaders", () => {
    // Activation used to call `loadFloatingControls()` free-floating while the
    // reloaders shared a promise chain. A workbook restored at startup emits
    // AFTER_OPEN / SHEET_CHANGED while that first read is still in flight, so
    // the outcome depended on which IPC round trip returned first. Seeding the
    // queue with it makes the last write win by ORDER.
    expect(INDEX_SRC).toContain("let documentReloadQueue: Promise<void> = loadFloatingControls();");
    // ...and there is no second, unserialised call left behind.
    expect(INDEX_SRC).not.toMatch(/^\s*loadFloatingControls\(\);\s*$/m);
  });

  it("invalidates picture caches rather than releasing them on a sheet swap", () => {
    // Media blob URLs are keyed by content hash and the controls come straight
    // back when the user switches sheets again; revoking would re-pull every
    // picture's bytes on every tab click. (AFTER_OPEN is the opposite case and
    // still releases: a handle from the closed document cannot resolve.)
    const handler = INDEX_SRC.slice(
      INDEX_SRC.indexOf("const reloadForSheetChange"),
      INDEX_SRC.indexOf("cleanupFns.push(context.events.on(AppEvents.SHEET_CHANGED"),
    );
    expect(handler).toContain("invalidateAllImageCaches()");
    expect(handler).not.toContain("releaseAllImageMedia()");
  });
});

// ============================================================================
// 6. The instanceId format has ONE home on this side of the seam
// ============================================================================

describe("control id round trip", () => {
  it("parses back exactly what makeFloatingControlId built", () => {
    for (const [s, r, c] of [[0, 0, 0], [2, 7, 3], [11, 1048575, 16383]] as const) {
      expect(parseFloatingControlId(makeFloatingControlId(s, r, c))).toEqual({
        sheetIndex: s,
        row: r,
        col: c,
      });
    }
  });

  it("returns null for anything that is not one of ours", () => {
    for (const bad of ["", "control", "control-0-0", "control-0-0-0-0", "chart-1", "control-a-b-c", "pane-x"]) {
      expect(parseFloatingControlId(bad), bad).toBeNull();
    }
  });
});
