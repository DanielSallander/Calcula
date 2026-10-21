//! FILENAME: app/src/api/scriptHost/__tests__/setStateAspectRows.test.ts
// PURPOSE: The three POINTER aspects of a ScriptObjectHandle -- `binding.set`
//          (bindProperty), `binding.clear` (unbindProperty) and `property.set`
//          (setProperty) -- each have their OWN row in vSetState, and every
//          refusal on those rows says why (D-BIND §3.19).
// CONTEXT: vSetState ends in `return true`. An aspect without a row is
//          therefore UNVALIDATED at restricted tier with no capability -- the
//          shape.setProperty lesson (CLAUDE.md "Common Mistakes"). For these
//          three that tail would let a script bind a button's `onSelect` (code
//          is never bound) or write a data: URI into a picture slot. The rows
//          are proved by refusing something the tail would admit: a path with
//          `onSelect` in it. Before the rows existed vSetState returned `true`
//          for `["binding.set", ["/properties/onSelect", "=A1"]]` (measured on
//          the bundled validator, 2026-10-15).
//
//          SABOTAGE (run 2026-10-15): delete the `binding.set` row from
//          vSetState -> "has its own row" goes red for binding.set (the tail
//          admits onSelect) while the direct checkBindingSetAspect cases stay
//          green; delete the `property.set` row -> the same for property.set.
//
//          Rows are STATELESS: they do not know the object's kind, so they
//          accept a path SOME kind's catalog row accepts. The executor holds
//          the call to the real kind (scriptObjectHandleDoor.test.ts), and Rust
//          holds it again at its own door.

import { describe, it, expect } from "vitest";
import {
  BINDING_OPTION_KEYS,
  MAX_BINDING_FORMULA_CHARS,
  MAX_BINDING_MODEL_CHARS,
  MAX_PROPERTY_LITERAL_CHARS,
  checkBindingClearAspect,
  checkBindingSetAspect,
  checkPropertySetAspect,
  MAX_STYLE_PROPERTY_CHARS,
  checkStylePropertyAspect,
  isBindingColor,
  vObjectAspect,
  vSetState,
} from "../validators";
import { BINDABLE_PATHS, neverBindableControlReason } from "../../objectBindings";

const ROWS = ["binding.set", "binding.clear", "property.set"] as const;

/** Arguments for `aspect` that are well-formed apart from the path. */
function argsFor(aspect: (typeof ROWS)[number], path: string): unknown[] {
  if (aspect === "binding.set") return [path, "=Sheet1!A1"];
  if (aspect === "binding.clear") return [path];
  return [path, "x"];
}

describe("each pointer aspect has its own vSetState row (never the `return true` tail)", () => {
  for (const aspect of ROWS) {
    it(`${aspect}: a path naming a button's onSelect is refused, with the reason`, () => {
      const why = neverBindableControlReason("onSelect");
      expect(why).toBe("'onSelect' is code; code is never bound.");
      const args = argsFor(aspect, "/properties/onSelect");
      expect(vSetState([aspect, args])).toBe(why);
      // The unlocked cross-object door delegates to the same row.
      expect(vObjectAspect(["control", "3f9c2a64-0000-7000-8000-000000000001", aspect, args])).toBe(why);
    });

    it(`${aspect}: held code, action wiring, placement and identity are refused too`, () => {
      for (const key of ["heldOnSelect", "macroRef", "action", "actionTarget", "x", "pinToGrid", "uid", "name"]) {
        const verdict = vSetState([aspect, argsFor(aspect, `/properties/${key}`)]);
        expect(verdict, key).toBe(neverBindableControlReason(key));
      }
    });

    it(`${aspect}: a malformed pointer is refused with the pointer sentence`, () => {
      expect(vSetState([aspect, argsFor(aspect, "spec/title")])).toMatch(/JSON Pointer/);
      expect(vSetState([aspect, argsFor(aspect, "/spec/~2bad")])).toMatch(/~0/);
      expect(vSetState([aspect, argsFor(aspect, "/a/b/c/d/e/f/g/h/i")])).toMatch(/too deep/);
      expect(vSetState([aspect, [42, "=A1"].slice(0, argsFor(aspect, "/x").length)])).toMatch(/must be a string/);
    });
  }

  it("a control key that IS bindable passes all three rows", () => {
    expect(vSetState(["binding.set", ["/properties/text", '="Total: "&Sheet1!B2']])).toBe(true);
    expect(vSetState(["binding.clear", ["/properties/text"]])).toBe(true);
    expect(vSetState(["property.set", ["/properties/text", "Total"]])).toBe(true);
  });
});

describe("binding.set (bindProperty) refusals", () => {
  it("refuses a path no kind's catalog lists", () => {
    const verdict = checkBindingSetAspect(["/spec/data", "=A1"]);
    expect(verdict).toMatch(/not a property any kind of object lets a script bind or set/);
    // No wildcard over control keys: a script-declared custom key is not bindable.
    expect(checkBindingSetAspect(["/properties/myCustomThing", "=A1"])).not.toBe(true);
    // pageOverrides itself is not a row; its per-button paths are (D §3.18a).
    expect(checkBindingSetAspect(["/properties/pageOverrides", "=A1"])).not.toBe(true);
  });

  it("refuses a formula that is not text, does not start with =, or is too long", () => {
    expect(checkBindingSetAspect(["/spec/title", 42])).toMatch(/must be text starting with "=", not a number/);
    expect(checkBindingSetAspect(["/spec/title", "Sheet1!A1"])).toMatch(/starts with "="/);
    expect(checkBindingSetAspect(["/spec/title", "   =   "])).toMatch(/starts with "="/);
    const long = "=" + "1".repeat(MAX_BINDING_FORMULA_CHARS);
    expect(checkBindingSetAspect(["/spec/title", long])).toMatch(
      new RegExp(`at most ${MAX_BINDING_FORMULA_CHARS} characters`),
    );
    expect(checkBindingSetAspect(["/spec/title", "=" + "1".repeat(MAX_BINDING_FORMULA_CHARS - 1)])).toBe(true);
  });

  it("takes { model?: string } and nothing else", () => {
    expect(BINDING_OPTION_KEYS).toEqual(["model"]);
    expect(checkBindingSetAspect(["/spec/title", "=[Revenue]", { model: "aw-model" }])).toBe(true);
    expect(checkBindingSetAspect(["/spec/title", "=[Revenue]", {}])).toBe(true);
    expect(checkBindingSetAspect(["/spec/title", "=[Revenue]", null])).toBe(true);
    expect(checkBindingSetAspect(["/spec/title", "=A1", { invariant: false }])).toMatch(/unknown binding option "invariant"/);
    expect(checkBindingSetAspect(["/spec/title", "=A1", { source: { kind: "user" } }])).toMatch(/unknown binding option "source"/);
    expect(checkBindingSetAspect(["/spec/title", "=A1", "aw-model"])).toMatch(/must be an object/);
    expect(checkBindingSetAspect(["/spec/title", "=A1", { model: 7 }])).toMatch(/non-empty model key/);
    expect(checkBindingSetAspect(["/spec/title", "=A1", { model: " " }])).toMatch(/non-empty model key/);
    expect(checkBindingSetAspect(["/spec/title", "=A1", { model: "m".repeat(MAX_BINDING_MODEL_CHARS + 1) }])).toMatch(
      new RegExp(`at most ${MAX_BINDING_MODEL_CHARS}`),
    );
  });

  it("refuses the wrong arity", () => {
    expect(checkBindingSetAspect(["/spec/title"])).toBe("expected [path, formula, options?]");
    expect(checkBindingSetAspect(["/spec/title", "=A1", {}, "extra"])).toBe("expected [path, formula, options?]");
    expect(checkBindingSetAspect("not an array")).toBe("expected [path, formula, options?]");
  });

  it("admits every catalog row's concrete path (the rows are not stricter than the catalog)", () => {
    for (const row of BINDABLE_PATHS) {
      const concrete = row.pointer
        .replace("/series/*/", "/series/0/")
        .replace("/params/*/", "/params/0/")
        .replace("/seriesColors/*", "/seriesColors/Revenue")
        .replace("/pageOverrides/*/", "/pageOverrides/name:Sales/");
      expect(checkBindingSetAspect([concrete, "=Sheet1!A1"]), concrete).toBe(true);
    }
  });
});

describe("binding.clear (unbindProperty) refusals", () => {
  it("checks the pointer and the never-bindable key, but NOT the catalog (orphans stay removable)", () => {
    expect(checkBindingClearAspect(["/spec/title"])).toBe(true);
    // A row the catalog does not list (an older build's, an orphan's) can be cleared.
    expect(checkBindingClearAspect(["/spec/somethingRetired"])).toBe(true);
    expect(checkBindingClearAspect(["/properties/onSelect"])).toBe(neverBindableControlReason("onSelect"));
    expect(checkBindingClearAspect(["no-slash"])).toMatch(/JSON Pointer/);
    expect(checkBindingClearAspect(["/spec/title", "extra"])).toBe("expected [path]");
    expect(checkBindingClearAspect([])).toBe("expected [path]");
  });
});

// ============================================================================
// property.set (setProperty): one refusal per branch of D §3.19
// ============================================================================

describe("property.set (setProperty) is never laxer than the key-based door", () => {
  it("the value is ONE JSON scalar of at most 8 KiB of text", () => {
    expect(checkPropertySetAspect(["/spec/title", { text: "x" }])).toMatch(/ONE JSON value .* not an object/);
    expect(checkPropertySetAspect(["/spec/title", ["x"]])).toMatch(/not a list/);
    expect(checkPropertySetAspect(["/spec/xAxis/min", Number.NaN])).toMatch(/ONE JSON value/);
    expect(checkPropertySetAspect(["/spec/title", "t".repeat(MAX_PROPERTY_LITERAL_CHARS + 1)])).toMatch(
      new RegExp(`max ${MAX_PROPERTY_LITERAL_CHARS}`),
    );
    expect(checkPropertySetAspect(["/spec/title", null])).toBe(true);
    expect(checkPropertySetAspect(["/spec/title", "Q4 revenue"])).toBe(true);
  });

  // SABOTAGE (confirmed): return null at the top of containerLiteralRefusal ->
  // the out-of-range radius and the 1025-character title pass.
  it("(a) a format-container path is checked by the container's own leaf rule, after its catalog type (WP-C S7b)", () => {
    expect(checkPropertySetAspect(["/spec/container/title/show", true])).toBe(true);
    expect(checkPropertySetAspect(["/container/background/color", "#ffffff"])).toBe(true);
    // rgb() is the binding colour type; the Rust literal door stores it as hex.
    expect(checkPropertySetAspect(["/container/border/color", "rgb(255, 0, 16)"])).toBe(true);
    expect(checkPropertySetAspect(["/container/border/color", "red"])).toMatch(/is not a colour/);
    // The leaf rule, in Rust's own sentences.
    expect(checkPropertySetAspect(["/canvasFrame/container/border/radius", 101])).toBe(
      "border.radius must be a number from 0 to 100.",
    );
    expect(checkPropertySetAspect(["/canvasFrame/container/border/radius", 8])).toBe(true);
    expect(checkPropertySetAspect(["/canvasFrame/container/title/text", "x".repeat(1025)])).toBe(
      "title.text must be text of at most 1024 characters.",
    );
    expect(checkPropertySetAspect(["/canvasFrame/container/title/fontFamily", "Arial; x"])).toMatch(/at most 64 letters/);
    expect(checkPropertySetAspect(["/canvasFrame/container/title/headingLevel", 7])).toBe(
      "title.headingLevel must be a whole number from 0 to 6.",
    );
    // An enum is matched case-insensitively (Rust canonicalises it first).
    expect(checkPropertySetAspect(["/container/shadow/position", "TOPLEFT"])).toBe(true);
    // The catalog type comes first: a number where a boolean belongs.
    expect(checkPropertySetAspect(["/spec/container/title/show", 1])).toMatch(/takes TRUE or FALSE/);
    // A chart's title text has ONE spelling (spec.title): no container row.
    expect(checkPropertySetAspect(["/spec/container/title/text", "Revenue"])).toMatch(/not a property any kind/);
    // lockAspect is never bound or set through a catalog path.
    expect(checkPropertySetAspect(["/container/lockAspect", true])).toMatch(/not a property any kind/);
  });

  it("(b) a control key goes through checkShapeSetProperty after the catalog type", () => {
    // The media rule: a data: URI in `src`.
    expect(checkPropertySetAspect(["/properties/src", "data:image/png;base64,AAAA"])).toMatch(/must be a media handle/);
    // An over-range font size, and a font size spelled as text.
    expect(checkPropertySetAspect(["/properties/fontSize", 4000])).toMatch(/font size in points, from 1 to 409/);
    expect(checkPropertySetAspect(["/properties/fontSize", 0])).toMatch(/font size in points/);
    expect(checkPropertySetAspect(["/properties/fontSize", "12"])).toBe("'/properties/fontSize' takes a number, not text.");
    expect(checkPropertySetAspect(["/properties/fontSize", 12])).toBe(true);
    expect(checkPropertySetAspect(["/properties/opacity", 1.5])).toMatch(/opacity from 0/);
    expect(checkPropertySetAspect(["/properties/opacity", 0.4])).toBe(true);
    expect(checkPropertySetAspect(["/properties/fontBold", "true"])).toMatch(/takes TRUE or FALSE, not text/);
    expect(checkPropertySetAspect(["/properties/fontBold", true])).toBe(true);
    expect(checkPropertySetAspect(["/properties/fill", "red"])).toMatch(/is not a colour/);
    expect(checkPropertySetAspect(["/properties/fill", "#336699"])).toBe(true);
    // Code is refused before anything else -- by the row, with the reason.
    expect(checkPropertySetAspect(["/properties/onSelect", "alert(1)"])).toBe(neverBindableControlReason("onSelect"));
  });

  it("(c) any other catalog path is checked by its value type", () => {
    // An enum miss.
    expect(checkPropertySetAspect(["/spec/markOptions/displayUnits", "lakhs"])).toBe(
      "'lakhs' is not one of: auto, none, thousands, millions, billions, trillions (the values '/spec/markOptions/displayUnits' takes).",
    );
    expect(checkPropertySetAspect(["/spec/markOptions/displayUnits", "Millions"])).toBe(true);
    // A bad colour on a chart theme slot, an integer that is not whole, a boolean as text.
    expect(checkPropertySetAspect(["/spec/config/theme/titleColor", "rgb(300, 0, 0)"])).toMatch(/is not a colour/);
    expect(checkPropertySetAspect(["/spec/config/theme/titleColor", "rgba(10, 20, 30, 0.5)"])).toBe(true);
    expect(checkPropertySetAspect(["/spec/markOptions/decimals", 1.5])).toBe("'/spec/markOptions/decimals' takes a whole number.");
    expect(checkPropertySetAspect(["/showHeader", "yes"])).toMatch(/takes TRUE or FALSE, not text/);
    expect(checkPropertySetAspect(["/spec/xAxis/max", 100])).toBe(true);
    expect(checkPropertySetAspect(["/spec/params/0/value", true])).toBe(true);
    expect(checkPropertySetAspect(["/spec/config/theme/titleFontSize", 500])).toMatch(/font size in points/);
  });

  it("the colour rule matches Rust's is_binding_color shapes", () => {
    for (const ok of ["#a1B2c3", "#a1b2c3ff", "rgb(0,0,0)", " RGB(255, 255, 255) ", "rgba(1,2,3,1)", "rgba(1,2,3,.5)"]) {
      expect(isBindingColor(ok), ok).toBe(true);
    }
    for (const bad of ["red", "#abc", "#gggggg", "rgb(1,2)", "rgb(256,0,0)", "rgba(1,2,3,2)", "rgb(-1,0,0)", "rgb(1,2,3"]) {
      expect(isBindingColor(bad), bad).toBe(false);
    }
  });
});

// ============================================================================
// chart.setStyleProperty / slicer.setStyleProperty (round-2 security review)
// ============================================================================
//
// SABOTAGE (2026-10-17): delete the setStyleProperty row from vSetState ->
// every refusal below goes red (the `return true` tail admits a 3 MB value, a
// non-string and a data: URI) while "a style value passes" stays green.

describe("each style-override aspect has its own vSetState row (never the `return true` tail)", () => {
  for (const aspect of ["chart.setStyleProperty", "slicer.setStyleProperty"] as const) {
    it(`${aspect}: an unbounded value is refused`, () => {
      expect(vSetState([aspect, ["bg", "x".repeat(3_000_000)]])).toMatch(/max 256/);
      expect(vSetState([aspect, ["bg", "x".repeat(MAX_STYLE_PROPERTY_CHARS + 1)]])).toMatch(/max 256/);
    });

    it(`${aspect}: a non-string value or a malformed name is refused`, () => {
      expect(vSetState([aspect, ["bg", { nested: "x".repeat(10) }]])).toMatch(/must be a string/);
      expect(vSetState([aspect, ["bg", 42]])).toMatch(/must be a string/);
      expect(vSetState([aspect, ["", "#fff"]])).toMatch(/identifier/);
      expect(vSetState([aspect, ["a b", "#fff"]])).toMatch(/identifier/);
      expect(vSetState([aspect, ["x".repeat(65), "#fff"]])).toMatch(/identifier/);
      expect(vSetState([aspect, ["bg"]])).toBe("expected [name, value]");
    });

    it(`${aspect}: a data: URI or a url(...) is refused (reference media, never introduce bytes)`, () => {
      expect(vSetState([aspect, ["bg", "data:image/png;base64,AAAA"]])).toMatch(/never introduce bytes/);
      expect(vSetState([aspect, ["bg", "url(https://example.com/x.png)"]])).toMatch(/never introduce bytes/);
      // The unlocked cross-object door delegates to the same row.
      expect(vObjectAspect(["chart", "3f9c2a64-0000-7000-8000-000000000001", aspect, ["bg", 42]])).toMatch(
        /must be a string/,
      );
    });

    it(`${aspect}: a style value passes`, () => {
      expect(vSetState([aspect, ["bg", "#fff"]])).toBe(true);
      expect(vSetState([aspect, ["font_family", "Segoe UI"]])).toBe(true);
      expect(checkStylePropertyAspect(["fontSize", "12px"])).toBe(true);
    });
  }
});
