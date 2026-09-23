//! FILENAME: app/src/api/layout/__tests__/findHardcodedColours.test.tsx
// PURPOSE: Pins what the rendered-DOM colour scan (../testing.ts) reports and,
//          just as important, what it must NOT report — every false positive
//          here made an author write a local shim around the helper.

import { describe, it, expect, afterEach } from "vitest";
import { findHardcodedColours } from "../testing";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findHardcodedColours", () => {
  it("reports a hex, an rgba() and a named colour in an inline style", () => {
    expect(findHardcodedColours(mount(`<span style="color: #ff0000"></span>`))).toHaveLength(1);
    expect(findHardcodedColours(mount(`<span style="background: rgba(0,0,0,.1)"></span>`))).toHaveLength(1);
    expect(findHardcodedColours(mount(`<span style="border-color: black"></span>`))).toHaveLength(1);
  });

  it("allows the fallback half of var(--token, #literal)", () => {
    expect(findHardcodedColours(mount(`<span style="color: var(--text-primary, #111827)"></span>`))).toEqual([]);
  });

  it("does not read white-space as the colour white, but still sees a literal after it", () => {
    expect(findHardcodedColours(mount(`<span style="white-space: nowrap"></span>`))).toEqual([]);
    expect(
      findHardcodedColours(mount(`<span style="white-space: nowrap; color: white"></span>`)),
    ).toHaveLength(1);
  });

  it("does not read a font NAME as a colour (Arial Black), but still sees a colour beside it", () => {
    expect(findHardcodedColours(mount(`<span style='font-family: "Arial Black"'></span>`))).toEqual([]);
    expect(findHardcodedColours(mount(`<span style="font: 12px Arial Black"></span>`))).toEqual([]);
    expect(
      findHardcodedColours(mount(`<span style='font-family: "Arial Black"; color: #000'></span>`)),
    ).toHaveLength(1);
    // font-size is not a font name: its value still gets scanned.
    expect(findHardcodedColours(mount(`<span style="font-size: 12px; color: red"></span>`))).toHaveLength(1);
  });

  it("skips categorical colour DATA marked data-colour-data", () => {
    expect(
      findHardcodedColours(mount(`<div data-colour-data=""><span style="background: #4472c4"></span></div>`)),
    ).toEqual([]);
  });

  it("reports SVG fill/stroke literals but not currentColor or a var()", () => {
    expect(findHardcodedColours(mount(`<svg><rect fill="#333"></rect></svg>`))).toHaveLength(1);
    expect(
      findHardcodedColours(mount(`<svg><rect fill="currentColor" stroke="var(--icon-accent, #047857)"></rect></svg>`)),
    ).toEqual([]);
  });
});
