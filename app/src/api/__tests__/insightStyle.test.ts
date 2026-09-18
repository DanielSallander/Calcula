//! FILENAME: app/src/api/__tests__/insightStyle.test.ts
// PURPOSE: The overlay style: defaults that keep every polarity's dash
//          distinct, a normaliser that rescues field by field, document
//          precedence over defaults, and change notification.

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_OVERLAY_STYLE, POLARITIES, normalizeOverlayStyle, isOverlayColor, isDefaultOverlayStyle,
  setDocumentOverlayStyle, getDocumentOverlayStyle, resolveOverlayStyle, overlayStyleFor, onOverlayStyleChanged,
} from "../insightStyle";

beforeEach(() => setDocumentOverlayStyle(null));

describe("defaults", () => {
  it("give good and bad solid strokes and attention/neutral distinct dashes, so shape carries polarity", () => {
    const d = DEFAULT_OVERLAY_STYLE.polarity;
    expect(d.good.dash).toEqual([]);
    expect(d.bad.dash).toEqual([]);
    expect(d.attention.dash).not.toEqual(d.neutral.dash);
    expect(new Set(POLARITIES.map((p) => d[p].color)).size).toBe(4);
    expect(isDefaultOverlayStyle(DEFAULT_OVERLAY_STYLE)).toBe(true);
  });

  // The NEUTRAL default is the cue drawn when nothing declares a direction, and
  // the owner found the old one (#0e639c) invisible: it is the same blue family
  // as the default bar. It must also stay a grey: a red, green or amber cue
  // says the marked number is bad, good or worrying, which is precisely the
  // claim this polarity exists NOT to make (D-IO-2).
  it("keeps the neutral cue a grey, distinct from the default series colours", () => {
    const hex = DEFAULT_OVERLAY_STYLE.polarity.neutral.color;
    expect(hex, "a 6-digit hex, so the channels can be compared").toMatch(/^#[0-9a-f]{6}$/i);
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const spread = Math.max(r, g, b2) - Math.min(r, g, b2);
    expect(spread, `neutral must read as a grey, not a hue: ${hex}`).toBeLessThanOrEqual(16);
    expect(Math.max(r, g, b2), `and dark enough to show on a light plot: ${hex}`).toBeLessThan(140);

    // Not one of the palette colours a bar is actually painted with. The list is
    // repeated rather than imported: @api must never import an extension.
    const DEFAULT_SERIES_PALETTE = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"];
    for (const c of DEFAULT_SERIES_PALETTE) {
      const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      const distance = Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b2);
      expect(distance, `the neutral cue must not disappear into series colour ${c}`).toBeGreaterThan(120);
    }
  });
});

describe("normalizeOverlayStyle", () => {
  it("accepts a complete style and keeps it", () => {
    const s = normalizeOverlayStyle({
      polarity: { good: { color: "#00aa00", dash: [1, 1] }, bad: { color: "rgb(200, 0, 0)", dash: [] }, attention: { color: "orange", dash: [3] }, neutral: { color: "#123", dash: [2, 2] } },
      lineWidth: 3,
      bandOpacity: 0.3,
    });
    expect(s.polarity.good).toEqual({ color: "#00aa00", dash: [1, 1] });
    expect(s.polarity.bad.color).toBe("rgb(200, 0, 0)");
    expect(s.polarity.attention).toEqual({ color: "orange", dash: [3] });
    expect(s.lineWidth).toBe(3);
    expect(s.bandOpacity).toBe(0.3);
    expect(isDefaultOverlayStyle(s)).toBe(false);
  });

  it("rescues field by field: a bad colour, dash, width or opacity falls back alone", () => {
    const s = normalizeOverlayStyle({
      polarity: { good: { color: "url(javascript:x)", dash: [1, -1] }, bad: { color: "#ff0000" } },
      lineWidth: 99,
      bandOpacity: "lots",
    });
    expect(s.polarity.good).toEqual(DEFAULT_OVERLAY_STYLE.polarity.good);
    expect(s.polarity.bad).toEqual({ color: "#ff0000", dash: [] });
    expect(s.polarity.attention).toEqual(DEFAULT_OVERLAY_STYLE.polarity.attention);
    expect(s.lineWidth).toBe(DEFAULT_OVERLAY_STYLE.lineWidth);
    expect(s.bandOpacity).toBe(DEFAULT_OVERLAY_STYLE.bandOpacity);
  });

  it("answers the defaults for garbage", () => {
    for (const raw of [null, undefined, 42, "x", [], { polarity: 7 }]) {
      expect(isDefaultOverlayStyle(normalizeOverlayStyle(raw)), String(raw)).toBe(true);
    }
  });

  it("isOverlayColor admits canvas colours and refuses smuggling", () => {
    for (const ok of ["#abc", "#AABBCC", "rgb(1,2,3)", "rgba(1, 2, 3, 0.5)", "tomato"]) expect(isOverlayColor(ok), ok).toBe(true);
    for (const bad of ["url(x)", "#abcd", "javascript:alert(1)", "", "a".repeat(40), 12, "rgb(1,2,3); background: red"]) expect(isOverlayColor(bad), String(bad)).toBe(false);
  });
});

describe("the document's style", () => {
  it("wins over the defaults when set, and the defaults return when cleared", () => {
    expect(resolveOverlayStyle()).toBe(DEFAULT_OVERLAY_STYLE);
    setDocumentOverlayStyle(normalizeOverlayStyle({ polarity: { bad: { color: "#800000" } } }));
    expect(overlayStyleFor("bad").color).toBe("#800000");
    expect(overlayStyleFor("good").color).toBe(DEFAULT_OVERLAY_STYLE.polarity.good.color);
    expect(getDocumentOverlayStyle()?.polarity.bad.color).toBe("#800000");
    setDocumentOverlayStyle(null);
    expect(overlayStyleFor("bad").color).toBe(DEFAULT_OVERLAY_STYLE.polarity.bad.color);
  });

  it("normalises what it is given and notifies on change only", () => {
    let n = 0;
    const off = onOverlayStyleChanged(() => n++);
    setDocumentOverlayStyle({ polarity: { bad: { color: "nope!!", dash: [] } } } as never);
    expect(n).toBe(1);
    expect(getDocumentOverlayStyle()?.polarity.bad.color).toBe(DEFAULT_OVERLAY_STYLE.polarity.bad.color);
    setDocumentOverlayStyle({ polarity: { bad: { color: "nope!!", dash: [] } } } as never); // same result: no notification
    expect(n).toBe(1);
    setDocumentOverlayStyle(null);
    expect(n).toBe(2);
    setDocumentOverlayStyle(null);
    expect(n).toBe(2);
    off();
  });
});
