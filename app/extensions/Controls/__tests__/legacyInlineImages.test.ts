//! FILENAME: app/extensions/Controls/__tests__/legacyInlineImages.test.ts
// PURPOSE: The load side of the legacy image corpus: what the user is told, how
//          often, and — above all — what is NOT thrown away.
// CONTEXT: The rewrite itself is the host's
//          (`app/src-tauri/src/media.rs::migrate_legacy_data_urls`, tested
//          there: a legacy inline image becomes a handle, running it twice is a
//          no-op, one picture on three controls is one blob, and a payload this
//          build refuses is left ALONE rather than deleted). What is left for
//          the frontend is the honest report — a picture that could not be
//          converted still displays, still exists, and the user should hear that
//          once rather than never or on every reload.

import { describe, it, expect } from "vitest";
import type { ControlEntry } from "../lib/types";
import {
  collectUnmigratedInlineImages,
  legacyInlineImageWarning,
} from "../Image/legacyInlineImages";

const makeId = (sheetIndex: number, row: number, col: number) =>
  `floating-${sheetIndex}-${row}-${col}`;

function imageAt(row: number, src: string): ControlEntry {
  return {
    sheetIndex: 0,
    row,
    col: 0,
    metadata: {
      controlType: "image",
      properties: { src: { valueType: "static", value: src } },
    },
  };
}

describe("what still holds an inline picture after the host's migration", () => {
  it("a migrated image is not reported — it now holds a handle", () => {
    const entries = [imageAt(0, `media:${"a".repeat(64)}`)];
    expect(collectUnmigratedInlineImages(entries, makeId, new Set())).toEqual([]);
  });

  it("a picture the current rules refuse is reported, and is still THERE", () => {
    // An SVG logo the old picker accepted. The host declines to re-admit it and
    // leaves the payload untouched; this is the half that tells the user.
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    const entries = [imageAt(3, svg)];

    const found = collectUnmigratedInlineImages(entries, makeId, new Set());

    expect(found).toEqual(["floating-0-3-0"]);
    // Nothing was dropped, rewritten or blanked: reporting is not deleting.
    expect(entries[0].metadata.properties.src.value).toBe(svg);
  });

  it("reports each control ONCE per session, however often the sheet reloads", () => {
    // A structural undo re-reads the whole sheet. Re-toasting the same news on
    // every undo is how a true warning becomes noise the user learns to dismiss.
    const entries = [imageAt(1, "data:image/bmp;base64,Qk0="), imageAt(2, "data:image/png;base64,AA")];
    const reported = new Set<string>();

    expect(collectUnmigratedInlineImages(entries, makeId, reported)).toHaveLength(2);
    expect(collectUnmigratedInlineImages(entries, makeId, reported)).toHaveLength(0);

    // A control that appears later is still reported.
    entries.push(imageAt(9, "data:image/gif;base64,R0lG"));
    expect(collectUnmigratedInlineImages(entries, makeId, reported)).toEqual([
      "floating-0-9-0",
    ]);
  });

  it("ignores controls that have no src at all", () => {
    const button: ControlEntry = {
      sheetIndex: 0,
      row: 5,
      col: 5,
      metadata: {
        controlType: "button",
        properties: { text: { valueType: "static", value: "Run report" } },
      },
    };
    expect(collectUnmigratedInlineImages([button], makeId, new Set())).toEqual([]);
  });
});

describe("the message", () => {
  it("leads with 'nothing was removed' and names the rules that refused", () => {
    const message = legacyInlineImageWarning(3);
    expect(message).toContain("3 images are");
    expect(message).toContain("Nothing has been removed");
    expect(message).toContain("still display");
    expect(message).toContain("SVG");
    expect(message).toContain("8 MB");
  });

  it("reads correctly for a single picture", () => {
    expect(legacyInlineImageWarning(1)).toContain("1 image is");
  });
});
