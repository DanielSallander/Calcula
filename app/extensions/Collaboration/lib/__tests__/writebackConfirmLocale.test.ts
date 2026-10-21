// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackConfirmLocale.test.ts
// PURPOSE: The outbound values a subscriber is asked to confirm, and the counts
//          the tab and the pane print, go through the APP locale (@api/locale),
//          never the backend's invariant spelling ("1.5") or a raw `${n}`.
// CONTEXT: The consent step is where a wrong separator matters most: an sv-SE
//          subscriber who typed "1,5" was asked to confirm "B3 = 1.5".

import { describe, it, expect, vi } from "vitest";

vi.mock("@api/locale", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/locale")>()),
  // A recognisable stand-in for the app locale: the test proves the text is
  // ROUTED through formatNumber, whatever the locale is.
  formatNumber: (n: number) => `<${String(n).replace(".", ",")}>`,
}));

import { outboundValueText, outboundConfirmText, valuesText } from "../writebackTabModel";

function value(valueDisplay: string, valueKind: "number" | "text" | "boolean" | "empty") {
  return { cellRow: 2, cellCol: 1, valueDisplay, valueKind } as never;
}

describe("outbound values in the app locale", () => {
  it("formats a number, keeps text as typed, names a cleared cell", () => {
    expect(outboundValueText(value("1.5", "number"))).toBe("<1,5>");
    expect(outboundValueText(value("1.5", "text"))).toBe("1.5");
    expect(outboundValueText(value("", "empty"))).toBe("(cleared)");
    expect(outboundValueText(value("TRUE", "boolean"))).toBe("TRUE");
    // Not a number after all: shown as the backend sent it, never "NaN".
    expect(outboundValueText(value("abc", "number"))).toBe("abc");
  });

  it("the confirm lists the number as the subscriber reads it", () => {
    const text = outboundConfirmText([
      {
        regionId: "r1",
        packageName: "writeback-test",
        registryPath: "C:/ws",
        submitterName: "Dana",
        values: [value("1.5", "number")],
      } as never,
    ]);
    expect(text).toContain("  B3 = <1,5>");
    expect(text).not.toContain("B3 = 1.5");
  });

  it("counts go through the locale too", () => {
    expect(valuesText(1234)).toBe("<1234> values");
    expect(valuesText(1)).toBe("<1> value");
  });
});
