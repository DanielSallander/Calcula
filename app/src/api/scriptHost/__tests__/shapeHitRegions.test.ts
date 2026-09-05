//! FILENAME: app/src/api/scriptHost/__tests__/shapeHitRegions.test.ts
// PURPOSE: `render.setHitRegions` (M3b) — the door a shape script uses to claim
//          rectangles of its own HTML frame for pointer input — is a real,
//          validated, audited broker row, and its refusals are honest.
// CONTEXT: Before M3b the `ui.html` iframe was `pointer-events: none`
//          UNCONDITIONALLY, so a script's frame could never receive a click.
//          The fix hands a script part of the grid's pointer input, which makes
//          the declaration script-supplied data that reaches CSS — so it gets a
//          validator with bounds, not a `return true`.
//
//          IT IS DELIBERATELY NOT AN `object.setState` ASPECT. `vSetState` ends
//          in `return true`: an aspect nobody wrote an arm for is UNVALIDATED at
//          restricted tier with no capability, which is how `shape.setProperty`
//          became a route for a multi-megabyte `data:` URI into a signed .calp.
//          This test pins the row so a later "simplification" into an aspect
//          cannot happen silently.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLOWLIST } from "../allowlist";
import { capabilityAuditClassification } from "../broker";
import { vHitRegions } from "../validators";
import {
  MAX_SHAPE_HIT_COORD,
  MAX_SHAPE_HIT_REGIONS,
  MIN_SHAPE_HIT_SIZE,
  SHAPE_HIT_POINTER_MESSAGE_TYPE,
  SHAPE_HIT_REGIONS_EVENT,
  type ShapeHitRegion,
} from "../shapeHitRegionSpec";

const METHOD = "render.setHitRegions";

/** A valid rectangle, with only the fields a region carries. */
function rect(id: string, x = 0, y = 0, width = 10, height = 10): ShapeHitRegion {
  return { id, x, y, width, height };
}

// ============================================================================
// 1. The allowlist row
// ============================================================================

describe("the row", () => {
  it("exists at restricted tier behind ui.htmlInput, classed as a mutation", () => {
    const row = ALLOWLIST[METHOD];
    expect(row).toBeDefined();
    expect(row.tier).toBe("restricted");
    // A DIFFERENT capability from the frame it addresses (M6b). It used to be
    // the same one, on the reasoning that a rectangle is meaningless without a
    // frame and can never reach a pixel the frame does not cover — both true,
    // and both beside the point. `ui.html` promises RENDERING in every sentence
    // it is described by; claiming a rectangle TAKES the user's click away from
    // the grid. Consent text is a promise, so the two questions get two answers.
    expect(row.capability).toBe("ui.htmlInput");
    expect(row.capability).not.toBe(ALLOWLIST["render.setHtml"].capability);
    expect(row.class).toBe("mutate");
  });

  it("carries its OWN validator, not the aspect-router's `return true`", () => {
    expect(ALLOWLIST[METHOD].validate).toBe(vHitRegions);
    expect(ALLOWLIST[METHOD].validate).not.toBe(ALLOWLIST["object.setState"].validate);
  });

  it("is broker-audited: nothing server-side would record a claim on pointer input", () => {
    const { serverAudited, brokerAudited } = capabilityAuditClassification();
    expect(brokerAudited.has(METHOD)).toBe(true);
    expect(serverAudited.has(METHOD)).toBe(false);
  });

  it("says what a user consenting to it actually gets, INCLUDING the way out", () => {
    // Consent text is a promise. Every clause below is true of the shipped code:
    // undeclared pixels have no shim (shapeHitRegions.ts `syncShapeHitDom`),
    // and design mode removes every shim before any are placed.
    const desc = ALLOWLIST[METHOD].desc;
    expect(desc).toMatch(/still reach the grid/i);
    expect(desc).toMatch(/design mode/i);
  });
});

// ============================================================================
// 2. The validator's bounds
// ============================================================================

describe("vHitRegions accepts a real declaration", () => {
  it("takes a toolbar of rectangles", () => {
    expect(vHitRegions([[rect("save", 4, 4, 60, 24), rect("cancel", 70, 4, 60, 24)]])).toBe(true);
  });

  it("takes the empty list — the documented way to release the frame", () => {
    expect(vHitRegions([[]])).toBe(true);
  });

  it("takes exactly 16, the budget", () => {
    // The count is HARD-CODED here on purpose. Deriving both sides from
    // MAX_SHAPE_HIT_REGIONS makes raising the constant a silent no-op that no
    // test can see — which is exactly what a sabotage run of this file found.
    expect(MAX_SHAPE_HIT_REGIONS).toBe(16);
    const full = Array.from({ length: 16 }, (_, i) => rect(`r${i}`));
    expect(vHitRegions([full])).toBe(true);
  });
});

describe("vHitRegions refuses, and names the way out", () => {
  it("refuses the 17th rectangle", () => {
    const over = Array.from({ length: 17 }, (_, i) => rect(`r${i}`));
    const reason = vHitRegions([over]);
    expect(reason).not.toBe(true);
    expect(reason as string).toContain("16");
    expect(reason as string).toContain("17");
    // A refusal names what the author can do about it.
    expect(reason as string).toMatch(/merge adjacent rectangles/);
    expect(reason as string).toMatch(/release the frame/);
  });

  it("refuses a non-array", () => {
    for (const bad of [undefined, null, "save", 3, { id: "a" }]) {
      const reason = vHitRegions([bad]);
      expect(reason, JSON.stringify(bad)).not.toBe(true);
      expect(reason as string).toMatch(/release the frame/);
    }
  });

  it("refuses a negative coordinate", () => {
    const reason = vHitRegions([[rect("a", -1)]]);
    expect(reason).not.toBe(true);
    expect(reason as string).toMatch(/^hit region 0: x must be a finite number from 0/);
  });

  it("refuses a non-finite coordinate — Infinity and NaN both reach CSS as garbage", () => {
    expect(vHitRegions([[rect("a", Number.POSITIVE_INFINITY)]])).not.toBe(true);
    expect(vHitRegions([[rect("a", Number.NaN)]])).not.toBe(true);
    expect(vHitRegions([[rect("a", 0, 0, Number.POSITIVE_INFINITY, 10)]])).not.toBe(true);
  });

  it("refuses a coordinate past the frame bound, and a rectangle that ends past it", () => {
    expect(vHitRegions([[rect("a", MAX_SHAPE_HIT_COORD + 1)]])).not.toBe(true);
    const reason = vHitRegions([[rect("a", MAX_SHAPE_HIT_COORD - 1, 0, 10, 10)]]);
    expect(reason).not.toBe(true);
    expect(reason as string).toMatch(/must end within/);
  });

  it("refuses a rectangle nobody could aim at", () => {
    const reason = vHitRegions([[rect("a", 0, 0, 0, 10)]]);
    expect(reason).not.toBe(true);
    expect(reason as string).toContain(String(MIN_SHAPE_HIT_SIZE));
    expect(vHitRegions([[rect("a", 0, 0, 10, -5)]])).not.toBe(true);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    // An ignored key is a script author believing they configured something.
    const reason = vHitRegions([[{ ...rect("a"), cursor: "crosshair" }]]);
    expect(reason).not.toBe(true);
    expect(reason as string).toContain('unknown key "cursor"');
  });

  it("refuses a missing, empty, over-long or oddly-spelled id", () => {
    expect(vHitRegions([[{ x: 0, y: 0, width: 10, height: 10 }]])).not.toBe(true);
    expect(vHitRegions([[rect("")]])).not.toBe(true);
    expect(vHitRegions([[rect("a".repeat(65))]])).not.toBe(true);
    expect(vHitRegions([[rect("save me")]])).not.toBe(true);
    expect(vHitRegions([[rect("-lead")]])).not.toBe(true);
    expect(vHitRegions([[rect("ok.id:2-b_c")]])).toBe(true);
  });

  it("refuses duplicate ids — the id is what the frame is told was clicked", () => {
    const reason = vHitRegions([[rect("save"), rect("save", 20)]]);
    expect(reason).not.toBe(true);
    expect(reason as string).toContain('duplicate id "save"');
  });

  it("refuses a non-object entry", () => {
    expect(vHitRegions([["save"]])).not.toBe(true);
    expect(vHitRegions([[null]])).not.toBe(true);
    expect(vHitRegions([[[0, 0, 10, 10]]])).not.toBe(true);
  });

  it("never echoes an unbounded script string back into the refusal", () => {
    // The length check runs BEFORE the id is quoted, so a megabyte id is
    // refused by length and never appears in the message.
    const reason = vHitRegions([[rect("!".repeat(100_000))]]) as string;
    expect(reason).not.toBe(true);
    expect(reason.length).toBeLessThan(200);
  });
});

// ============================================================================
// 3. The five-file pattern, and the release on unmount
// ============================================================================

const host = readFileSync(resolve(__dirname, "../host.ts"), "utf8");
const shims = readFileSync(resolve(__dirname, "../worker/contextShims.ts"), "utf8");

/** The brace-matched body of the function whose header starts with `signature`. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/** Strip line comments so a commented-out call cannot satisfy an assertion. */
function codeOnly(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");
}

describe("the layers behind the row", () => {
  it("the worker shim calls the method by name (a row with no caller is dead text)", () => {
    expect(codeOnly(shims)).toContain(`callFire(rt, "${METHOD}"`);
  });

  it("the host executor forwards it on the one named event", () => {
    const impl = codeOnly(functionBody(host, "async function executeImpl("));
    expect(impl).toContain(`case "${METHOD}":`);
    expect(impl).toContain("SHAPE_HIT_REGIONS_EVENT");
  });

  it("hostUnmountScript RELEASES the claim — pointer input must not outlive the code", () => {
    // The same sweep that closes forms, dialogs and panes. Without this, an
    // unmounted script's shims keep eating clicks over the grid forever.
    const unmount = codeOnly(functionBody(host, "export function hostUnmountScript("));
    expect(unmount.length).toBeGreaterThan(800);
    expect(unmount).toContain("SHAPE_HIT_REGIONS_EVENT");
    expect(unmount).toMatch(/regions:\s*\[\]/);
  });
});

describe("the wire names are shared, never re-typed", () => {
  it("the event and the pointer message type live in the spec module", () => {
    expect(SHAPE_HIT_REGIONS_EVENT).toBe("shape:setHitRegions");
    // Namespaced so it cannot collide with a `type` the script chose for its
    // own render.sendMessage traffic.
    expect(SHAPE_HIT_POINTER_MESSAGE_TYPE).toBe("calcula:pointer");
  });
});
