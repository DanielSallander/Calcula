//! FILENAME: app/src/api/scriptHost/__tests__/mediaHandles.test.ts
// PURPOSE: Make "a script may REFERENCE media, never INTRODUCE bytes" a
//          property of the code rather than a paragraph in a design doc.
// CONTEXT: This suite exists because of a shipped defect, not a hypothetical.
//          `object.setState` is restricted tier with NO capability, and
//          vSetState returned `true` for the `shape.setProperty` aspect with no
//          key allowlist and no length bound — so a DISTRIBUTED, restricted
//          script could write a multi-megabyte data: URI into a persisted
//          control property, which then travelled into a published .calp and
//          under its detached signature. The backend now bounds every property
//          write at 64 KiB (MAX_CONTROL_PROPERTY_CHARS, the door every route
//          converges on); these tests bound the SCRIPT door harder and, more
//          importantly, make the `src` slot media-only so bytes cannot enter by
//          that name at all.
//
//          Three properties are asserted here and each maps to a way the old
//          shape failed:
//            1. `src` accepts a media: handle and NOTHING else (no data: URI,
//               no URL, no path) — the ingress.
//            2. every other property write is key-checked and length-bounded —
//               the storage-abuse and typo cases.
//            3. the import arm hands back a HANDLE, never bytes — the reason
//               the capability can ride file.picker without widening it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as nodeFs from "fs";
import * as nodePath from "path";
import {
  vSetState,
  vObjectAspect,
  vCreatePicture,
  checkShapeSetProperty,
  isMediaRef,
  MEDIA_REF_RE,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_PIXELS,
  MAX_SHAPE_PROPERTY_CHARS,
  MAX_SHAPE_PROPERTY_KEY,
  SCRIPT_SHAPE_PROPERTY_KEYS,
  SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import { METHOD_DEADLINES_MS } from "../protocol";
import { capabilityAuditClassification } from "../broker";

/** A syntactically valid handle: "media:" + 64 lowercase hex. */
const HANDLE = "media:" + "a".repeat(64);
const HANDLE_2 = "media:" + "0123456789abcdef".repeat(4);

// ============================================================================
// 1. The handle shape, pinned to the Rust definition
// ============================================================================
//
// A handle is used as an ARCHIVE ENTRY NAME (media/{sha256}) and is resolved
// host-side to a data: URL for painting. Both of those make a loose match
// dangerous in a way a strict one is not: "media:../../x" is a path, and
// "media:https://tracker" is a beacon. Rust's parse_media_ref is the authority;
// this suite pins the TypeScript twin to it by reading the source.

describe("the media: handle shape", () => {
  it("accepts exactly 64 LOWERCASE hex characters after the prefix", () => {
    expect(isMediaRef(HANDLE)).toBe(true);
    expect(isMediaRef(HANDLE_2)).toBe(true);
  });

  it("refuses everything a handle could be confused with", () => {
    expect(isMediaRef("media:" + "A".repeat(64))).toBe(false); // uppercase
    expect(isMediaRef("media:" + "a".repeat(63))).toBe(false); // too short
    expect(isMediaRef("media:" + "a".repeat(65))).toBe(false); // too long
    expect(isMediaRef("media:" + "g".repeat(64))).toBe(false); // not hex
    expect(isMediaRef("media:../../etc/passwd")).toBe(false); // a path
    expect(isMediaRef("media:https://tracker.example.com/x")).toBe(false); // a beacon
    expect(isMediaRef(" " + HANDLE)).toBe(false); // leading space
    expect(isMediaRef(HANDLE + "\n")).toBe(false); // trailing newline
    expect(isMediaRef(HANDLE + HANDLE)).toBe(false); // concatenated
    expect(isMediaRef("")).toBe(false);
    expect(isMediaRef(null)).toBe(false);
    expect(isMediaRef(42)).toBe(false);
  });

  it("is anchored at both ends (a substring match would be a path traversal)", () => {
    expect(MEDIA_REF_RE.source.startsWith("^")).toBe(true);
    expect(MEDIA_REF_RE.source.endsWith("$")).toBe(true);
  });

  it("agrees with parse_media_ref in core/calcula-format/src/media.rs", () => {
    // Read the RUST SOURCE rather than trusting a comment: the two
    // implementations are on opposite sides of an IPC boundary, and a handle
    // the frontend minted that Rust rejects (or vice versa) is a picture that
    // silently does not render.
    const rust = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../../../../core/calcula-format/src/media.rs"),
      "utf8",
    );
    expect(rust).toContain('pub const MEDIA_REF_PREFIX: &str = "media:";');
    // 64 chars, ascii digit or a..f — the exact predicate parse_media_ref uses.
    expect(rust).toMatch(/hash\.len\(\) == 64/);
    expect(rust).toMatch(/is_ascii_digit\(\)/);
    expect(rust).toMatch(/b'a'\.\.=b'f'/);
    // And the two caps this file quotes in its consent text.
    const bytes = /pub const MAX_MEDIA_BYTES: usize = ([^;]+);/.exec(rust);
    const pixels = /pub const MAX_MEDIA_PIXELS: u64 = ([^;]+);/.exec(rust);
    expect(bytes, "MAX_MEDIA_BYTES not found in media.rs").not.toBeNull();
    expect(pixels, "MAX_MEDIA_PIXELS not found in media.rs").not.toBeNull();
    // eslint-disable-next-line no-eval
    expect(eval(bytes![1].replace(/_/g, ""))).toBe(MAX_MEDIA_BYTES);
    // eslint-disable-next-line no-eval
    expect(eval(pixels![1].replace(/_/g, ""))).toBe(MAX_MEDIA_PIXELS);
  });
});

// ============================================================================
// 2. shape.setProperty — the `src` slot is media-only
// ============================================================================

describe("shape.setProperty: the src slot", () => {
  it("accepts a well-formed media handle", () => {
    expect(vSetState(["shape.setProperty", ["src", HANDLE]])).toBe(true);
  });

  it('accepts "" — clearing a picture is a legitimate edit', () => {
    expect(vSetState(["shape.setProperty", ["src", ""]])).toBe(true);
  });

  it("REFUSES a data: URI — this is the ingress that shipped", () => {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const verdict = vSetState(["shape.setProperty", ["src", dataUri]]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("media:");
  });

  it("REFUSES a http(s) URL — the CSP must not be the only thing stopping a beacon", () => {
    for (const url of [
      "https://tracker.example.com/pixel.png",
      "http://192.168.0.1/x.gif",
      "//cdn.example.com/logo.png",
      "blob:https://example.com/9c0f",
    ]) {
      expect(vSetState(["shape.setProperty", ["src", url]]), url).not.toBe(true);
    }
  });

  it("REFUSES a file path", () => {
    for (const p of ["C:\\Users\\me\\logo.png", "\\\\server\\share\\logo.png", "./logo.png"]) {
      expect(vSetState(["shape.setProperty", ["src", p]]), p).not.toBe(true);
    }
  });

  it("REFUSES an over-long string, whatever it claims to be", () => {
    // The old shape accepted this and the backend stored it verbatim.
    expect(vSetState(["shape.setProperty", ["src", "x".repeat(4_000_000)]])).not.toBe(true);
    // Even a string that STARTS with a valid handle: the match is anchored.
    expect(vSetState(["shape.setProperty", ["src", HANDLE + "x".repeat(100_000)]])).not.toBe(true);
  });

  it("REFUSES a non-string value (no coercion into the media slot)", () => {
    expect(vSetState(["shape.setProperty", ["src", 42]])).not.toBe(true);
    expect(vSetState(["shape.setProperty", ["src", { ref: HANDLE }]])).not.toBe(true);
    expect(vSetState(["shape.setProperty", ["src", null]])).not.toBe(true);
  });
});

// ============================================================================
// 3. shape.setProperty — every other key
// ============================================================================

describe("shape.setProperty: keys and bounds", () => {
  it("accepts the real property keys the Controls extension defines", () => {
    for (const key of SCRIPT_SHAPE_PROPERTY_KEYS) {
      if (key === "src") continue; // its own rule, covered above
      expect(vSetState(["shape.setProperty", [key, "value"]]), key).toBe(true);
    }
  });

  it("accepts a script-DECLARED custom property (declareProperties is a shipped feature)", () => {
    // The validator is stateless, so it cannot know which keys an instance
    // declared. The tail is therefore open by SPELLING and closed by the value
    // bound plus the src/refused rules that run first.
    expect(vSetState(["shape.setProperty", ["threshold", "5"]])).toBe(true);
    expect(vSetState(["shape.setProperty", ["_accentColor", "#0078d4"]])).toBe(true);
    expect(vSetState(["shape.setProperty", ["refreshInterval2", "30"]])).toBe(true);
  });

  it("REFUSES a key that is not identifier-shaped, and lists what IS accepted", () => {
    const verdict = vSetState(["shape.setProperty", ["../../etc", "x"]]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("unknown shape property");
    // The house style: name the accepted set, so a typo is self-diagnosing.
    expect(String(verdict)).toContain("shapeType");
    expect(String(verdict)).toContain("declareProperties");
    for (const bad of ["9lives", "has space", "dotted.key", "semi;colon", "", "-x"]) {
      expect(vSetState(["shape.setProperty", [bad, "x"]]), JSON.stringify(bad)).not.toBe(true);
    }
  });

  it("REFUSES an over-long key", () => {
    expect(vSetState(["shape.setProperty", ["a".repeat(MAX_SHAPE_PROPERTY_KEY), "x"]])).toBe(true);
    expect(
      vSetState(["shape.setProperty", ["a".repeat(MAX_SHAPE_PROPERTY_KEY + 1), "x"]]),
    ).not.toBe(true);
  });

  it("BOUNDS every value — this is the multi-megabyte hole, closed", () => {
    expect(
      vSetState(["shape.setProperty", ["text", "x".repeat(MAX_SHAPE_PROPERTY_CHARS)]]),
    ).toBe(true);
    const verdict = vSetState([
      "shape.setProperty",
      ["text", "x".repeat(MAX_SHAPE_PROPERTY_CHARS + 1)],
    ]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain(String(MAX_SHAPE_PROPERTY_CHARS));
    // A custom key is bounded identically — the open tail is not a bypass.
    expect(vSetState(["shape.setProperty", ["myBlob", "x".repeat(5_000_000)]])).not.toBe(true);
  });

  it("is TIGHTER than the backend bound, and deliberately so", () => {
    // app/src-tauri/src/controls.rs bounds EVERY route at 64 KiB because it
    // also admits inline onSelect script source written by trusted UI. The
    // script door is narrower: a script may not write onSelect at all.
    const backend = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../../../src-tauri/src/controls.rs"),
      "utf8",
    );
    const m = /pub const MAX_CONTROL_PROPERTY_CHARS: usize = ([^;]+);/.exec(backend);
    expect(m, "MAX_CONTROL_PROPERTY_CHARS not found in controls.rs").not.toBeNull();
    // eslint-disable-next-line no-eval
    const backendCap = eval(m![1].replace(/_/g, "")) as number;
    expect(MAX_SHAPE_PROPERTY_CHARS).toBeLessThan(backendCap);
  });

  it("REFUSES the executable slots (onSelect, macroRef) with an explanation", () => {
    for (const key of SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS) {
      const verdict = vSetState(["shape.setProperty", [key, "context.notify('hi')"]]);
      expect(verdict, key).not.toBe(true);
      expect(String(verdict)).toContain("ACTION");
    }
    // Nothing legitimate is lost: neither key is in the shape/image property
    // sets, so a shape never had them.
    expect(SCRIPT_SHAPE_PROPERTY_KEYS).not.toContain("onSelect");
    expect(SCRIPT_SHAPE_PROPERTY_KEYS).not.toContain("macroRef");
  });

  it("REFUSES a malformed arg list rather than reading past the end", () => {
    expect(vSetState(["shape.setProperty", []])).not.toBe(true);
    expect(vSetState(["shape.setProperty", ["fill"]])).not.toBe(true);
    expect(vSetState(["shape.setProperty", "notAnArray"])).not.toBe(true);
    expect(checkShapeSetProperty(undefined)).not.toBe(true);
  });
});

// ============================================================================
// 3b. The key list must not drift from the extension that owns the properties
// ============================================================================
//
// SCRIPT_SHAPE_PROPERTY_KEYS is a literal in validators.ts, and it has to be:
// @api is policy and app/extensions is a feature, and the Facade Rule runs both
// ways — policy must not import a feature. The cost of that is a second copy,
// and the price of a second copy is this test. It reads the EXTENSION SOURCE
// (never imports it, so the boundary lint stays satisfied) and fails when
// Controls adds a property the gate would then refuse.

/** The `key: "..."` entries of one PropertyDefinition array in a source file. */
function propertyKeysIn(relPath: string, arrayName: string): string[] {
  const src = nodeFs.readFileSync(
    nodePath.resolve(__dirname, "../../../../extensions/Controls", relPath),
    "utf8",
  );
  const start = src.indexOf(arrayName);
  expect(start, `${arrayName} not found in ${relPath}`).toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  // The arrays are the last export in each file, so "to the end" is safe and
  // avoids brace-matching a TypeScript object literal by hand.
  return [...src.slice(open).matchAll(/^\s{4}key: "([^"]+)",/gm)].map((m) => m[1]);
}

describe("the shape-property key list tracks the Controls extension", () => {
  it("covers every SHAPE property Controls defines", () => {
    const keys = propertyKeysIn("Shape/shapeProperties.ts", "SHAPE_PROPERTIES: PropertyDefinition[]");
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(SCRIPT_SHAPE_PROPERTY_KEYS, `SHAPE_PROPERTIES.${k}`).toContain(k);
    }
  });

  it("covers every IMAGE property Controls defines", () => {
    const keys = propertyKeysIn("Image/imageProperties.ts", "IMAGE_PROPERTIES: PropertyDefinition[]");
    expect(keys).toContain("src");
    for (const k of keys) {
      expect(SCRIPT_SHAPE_PROPERTY_KEYS, `IMAGE_PROPERTIES.${k}`).toContain(k);
    }
  });

  it("covers the BUTTON properties EXCEPT the executable one, which is refused by name", () => {
    const keys = propertyKeysIn("lib/types.ts", "BUTTON_PROPERTIES: PropertyDefinition[]");
    expect(keys).toContain("onSelect");
    for (const k of keys) {
      if (SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS.includes(k)) {
        expect(SCRIPT_SHAPE_PROPERTY_KEYS, k).not.toContain(k);
        continue;
      }
      expect(SCRIPT_SHAPE_PROPERTY_KEYS, `BUTTON_PROPERTIES.${k}`).toContain(k);
    }
  });

  it("keeps macroRef refused, spelled the way the seam spells it", () => {
    const seam = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../buttonControlService.ts"),
      "utf8",
    );
    const m = /export const MACRO_REF_PROPERTY = "([^"]+)";/.exec(seam);
    expect(m, "MACRO_REF_PROPERTY not found in buttonControlService.ts").not.toBeNull();
    expect(SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS).toContain(m![1]);
  });
});

// ============================================================================
// 4. BOTH setState doors land on the same gate
// ============================================================================
//
// The containment that makes the restricted tier mean anything is that
// `object.setState` is PINNED to the caller's own instance (host.ts passes the
// mount handle's instanceId) while only the UNLOCKED `api.objectSetState` can
// name a target. That split is worth nothing if the cross-instance door is also
// the LAX one, so vObjectAspect delegates to vSetState — asserted here.

describe("api.objectSetState is not the lax way in", () => {
  it("applies the identical shape gate when the aspect is aimed by id", () => {
    expect(vObjectAspect(["shape", "control-0-1-2", "shape.setProperty", ["src", HANDLE]])).toBe(true);
    expect(
      vObjectAspect(["shape", "control-0-1-2", "shape.setProperty", ["src", "data:image/png;base64,AAAA"]]),
    ).not.toBe(true);
    expect(
      vObjectAspect(["shape", "control-0-1-2", "shape.setProperty", ["onSelect", "x"]]),
    ).not.toBe(true);
    expect(
      vObjectAspect(["shape", "control-0-1-2", "shape.setProperty", ["text", "x".repeat(99_999)]]),
    ).not.toBe(true);
  });

  it("keeps the tier split it relies on: cross-instance access is unlocked-only", () => {
    // If this ever flips, a restricted script could aim shape.setProperty at
    // ANOTHER object and the "own instance" reasoning above evaporates.
    expect(ALLOWLIST["api.objectSetState"].tier).toBe("unlocked");
    expect(ALLOWLIST["api.objectGetState"].tier).toBe("unlocked");
    // ...and the own-object door stays restricted with no capability, which is
    // precisely why the gate above has to exist.
    expect(ALLOWLIST["object.setState"].tier).toBe("restricted");
    expect(ALLOWLIST["object.setState"].capability).toBeUndefined();
  });
});

// ============================================================================
// 5. api.createPicture
// ============================================================================

describe("vCreatePicture", () => {
  it("accepts a handle, an anchor, and the optional placement keys", () => {
    expect(vCreatePicture([HANDLE, { row: 2, col: 1 }])).toBe(true);
    expect(vCreatePicture([HANDLE, { row: 0, col: 0 }, undefined])).toBe(true);
    expect(vCreatePicture([HANDLE, { row: 2, col: 1 }, { width: 240 }])).toBe(true);
    expect(
      vCreatePicture([HANDLE, { row: 2, col: 1 }, { width: 240, height: 120, name: "Logo" }]),
    ).toBe(true);
  });

  it("REFUSES anything that is not a media handle as the picture", () => {
    for (const bad of [
      "data:image/png;base64,iVBORw0KGgo=",
      "https://example.com/logo.png",
      "C:\\logo.png",
      "logo.png",
      "media:nothex",
      "",
      42,
      null,
      undefined,
      { ref: HANDLE },
    ]) {
      const verdict = vCreatePicture([bad, { row: 0, col: 0 }]);
      expect(verdict, JSON.stringify(bad)).not.toBe(true);
    }
    expect(String(vCreatePicture(["data:image/png;base64,AA", { row: 0, col: 0 }]))).toContain(
      "media:",
    );
  });

  it("REFUSES a malformed anchor", () => {
    expect(vCreatePicture([HANDLE, undefined])).not.toBe(true);
    expect(vCreatePicture([HANDLE, "B3"])).not.toBe(true); // resolved worker-side
    expect(vCreatePicture([HANDLE, { row: -1, col: 0 }])).not.toBe(true);
    expect(vCreatePicture([HANDLE, { row: 1.5, col: 0 }])).not.toBe(true);
    expect(vCreatePicture([HANDLE, { row: 0 }])).not.toBe(true);
    // No sheet slot: pictures land on the ACTIVE sheet, so a sheet key is a
    // silent lie rather than an option.
    expect(vCreatePicture([HANDLE, { row: 0, col: 0, sheetIndex: 2 }])).not.toBe(true);
  });

  it("REFUSES unknown options and out-of-range geometry, with the accepted list", () => {
    const verdict = vCreatePicture([HANDLE, { row: 0, col: 0 }, { sheetIndex: 1 }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("name, width, height");
    expect(vCreatePicture([HANDLE, { row: 0, col: 0 }, { width: 0 }])).not.toBe(true);
    expect(vCreatePicture([HANDLE, { row: 0, col: 0 }, { height: 100_000 }])).not.toBe(true);
    expect(vCreatePicture([HANDLE, { row: 0, col: 0 }, { width: "240" }])).not.toBe(true);
  });
});

// ============================================================================
// 6. Policy rows
// ============================================================================

describe("the policy rows for media", () => {
  it("puts cap.fileImportMedia on the EXISTING file.picker capability", () => {
    const row = ALLOWLIST["cap.fileImportMedia"];
    expect(row).toBeDefined();
    // No new capability id: "the user picks one file and the host does the I/O"
    // is what file.picker already means, and it is exactly this.
    expect(row.capability).toBe("file.picker");
    expect(row.tier).toBe("restricted");
    expect(row.class).toBe("file");
    // The picker is person-bounded, so it carries the long deadline like its
    // three siblings — otherwise the worker abandons the call mid-dialog.
    expect(METHOD_DEADLINES_MS["cap.fileImportMedia"]).toBe(
      METHOD_DEADLINES_MS["cap.fileImportText"],
    );
  });

  it("states the caps a user is consenting to, from the enforcing source", () => {
    expect(ALLOWLIST["cap.fileImportMedia"].limits).toEqual({
      maxBytes: MAX_MEDIA_BYTES,
      maxPixels: MAX_MEDIA_PIXELS,
    });
  });

  it("promises a REFERENCE and not the data, in the consent line itself", () => {
    const desc = ALLOWLIST["cap.fileImportMedia"].desc.toLowerCase();
    expect(desc).toContain("reference");
    expect(desc).toContain("never the picture's data");
  });

  it("is audited by the broker, because no Rust gate records it", () => {
    const { brokerAudited, serverAudited } = capabilityAuditClassification();
    expect(brokerAudited.has("cap.fileImportMedia")).toBe(true);
    expect(serverAudited.has("cap.fileImportMedia")).toBe(false);
  });

  it("puts api.createPicture at unlocked tier with NO capability, like createChart", () => {
    const row = ALLOWLIST["api.createPicture"];
    expect(row).toBeDefined();
    expect(row.tier).toBe("unlocked");
    expect(row.capability).toBeUndefined();
    expect(row.class).toBe("mutate");
    expect(row.tier).toBe(ALLOWLIST["api.createChart"].tier);
    expect(row.class).toBe(ALLOWLIST["api.createTable"].class);
  });
});

// ============================================================================
// 7. The import arm returns a HANDLE, never bytes
// ============================================================================
//
// This is the assertion the whole design rests on, so it is made against the
// real host executor rather than against the type. The host RE-PROJECTS the
// picker's answer field by field: `MediaRef` has no `data` member and a Rust
// test guards that, but this is the door with the SANDBOX on the other side,
// and a sixth field arriving here later must not travel by default.

describe("cap.fileImportMedia hands back a handle, not an image", () => {
  const picked = {
    ref: HANDLE,
    mimeType: "image/png",
    width: 640,
    height: 480,
    byteLength: 12_345,
  };

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../../filesystem");
    vi.resetModules();
  });

  it("returns exactly the five handle fields, dropping anything else", async () => {
    const importImageViaPicker = vi.fn(async () => ({
      ...picked,
      // A hostile / future / buggy shape: bytes riding along. Whatever the
      // reason, they must not reach the worker.
      data: "AAAABBBBCCCC",
      path: "C:\\Users\\me\\logo.png",
    }));
    vi.doMock("../../filesystem", () => ({ importImageViaPicker }));
    const { executeMediaImport } = await import("../host");
    const out = await executeMediaImport("My Script");
    expect(out).toEqual(picked);
    expect(Object.keys(out as object).sort()).toEqual([
      "byteLength",
      "height",
      "mimeType",
      "ref",
      "width",
    ]);
    expect(JSON.stringify(out)).not.toContain("AAAABBBB");
    expect(JSON.stringify(out)).not.toContain("Users");
  });

  it("names the asking script in the picker title, and passes nothing else", async () => {
    const importImageViaPicker = vi.fn(async () => picked);
    vi.doMock("../../filesystem", () => ({ importImageViaPicker }));
    const { executeMediaImport } = await import("../host");
    await executeMediaImport("Quarterly Report");
    expect(importImageViaPicker).toHaveBeenCalledTimes(1);
    const [request] = importImageViaPicker.mock.calls[0] as [{ title: string }];
    // The script cannot influence the picker: there is no options object on the
    // call at all, so the format filter stays the HOST's decision.
    expect(Object.keys(request)).toEqual(["title"]);
    expect(request.title).toContain("Quarterly Report");
  });

  it("resolves null when the user cancels — never rejects, never hangs", async () => {
    const importImageViaPicker = vi.fn(async () => null);
    vi.doMock("../../filesystem", () => ({ importImageViaPicker }));
    const { executeMediaImport } = await import("../host");
    await expect(executeMediaImport("My Script")).resolves.toBeNull();
  });

  it("lets a refusal through as a rejection, rather than inventing a placeholder", async () => {
    // The behaviour this replaces fell back to {200, 150} on a decode error and
    // embedded the file anyway. A refusal must reach the script author.
    const importImageViaPicker = vi.fn(async () => {
      throw new Error("that file is 41 MB; the limit is 8 MB");
    });
    vi.doMock("../../filesystem", () => ({ importImageViaPicker }));
    const { executeMediaImport } = await import("../host");
    await expect(executeMediaImport("My Script")).rejects.toThrow(/41 MB/);
  });
});
