//! FILENAME: app/src/api/__tests__/buttonControlService.test.ts
// PURPOSE: The button-creation seam refuses LOUDLY when nothing is registered,
//          and hands back the provider's own instanceId when something is.
// CONTEXT: The seam exists because a caller that hand-rolled control metadata
//          reported success and drew no button. A seam that answered "no
//          provider" with a silent no-op would reproduce exactly that failure,
//          so the refusal is the behaviour under test, not an edge case.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  hasButtonControlProvider,
  registerButtonControlProvider,
  requireButtonControlProvider,
  resetButtonControlProvider,
  PAGE_NAVIGATOR_CONTROL_TYPE,
  PAGE_NAVIGATOR_OVERRIDES_PROPERTY,
  PAGE_NAVIGATOR_ORIENTATIONS,
  MAX_PAGE_NAVIGATOR_OVERRIDES,
  MAX_PAGE_NAVIGATOR_CAPTION,
  MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS,
  PAGE_NAVIGATOR_NATURAL_ITEM,
  PAGE_NAVIGATOR_DEFAULT_SIZE,
  pageNavigatorNaturalSize,
  parsePageNavigatorOverrides,
  serializePageNavigatorOverrides,
  checkPageNavigatorOverrides,
  matchPageNavigatorOverride,
  checkCreatePageNavigator,
  type ButtonControlHandle,
  type ButtonControlProvider,
  type CreateButtonControlRequest,
  type CreatePageNavigatorRequest,
  type PageNavigatorOverride,
} from "../buttonControlService";

function fakeProvider(
  onCreate?: (req: CreateButtonControlRequest) => void,
): ButtonControlProvider {
  return {
    async createButton(request): Promise<ButtonControlHandle> {
      onCreate?.(request);
      return {
        instanceId: `control-${request.sheetIndex}-${request.row}-${request.col}`,
        sheetIndex: request.sheetIndex,
        row: request.row,
        col: request.col,
        x: 100,
        y: 40,
        width: 80,
        height: 28,
      };
    },
    async removeButton(): Promise<void> {
      /* no-op */
    },
    async createPageNavigator(request): Promise<ButtonControlHandle> {
      return {
        instanceId: `control-${request.sheetIndex}-nav`,
        sheetIndex: request.sheetIndex,
        row: request.row ?? 0,
        col: request.col ?? 0,
        x: request.x ?? 0,
        y: request.y ?? 0,
        width: request.width ?? PAGE_NAVIGATOR_DEFAULT_SIZE.width,
        height: request.height ?? PAGE_NAVIGATOR_DEFAULT_SIZE.height,
      };
    },
  };
}

describe("buttonControlService (IoC seam)", () => {
  beforeEach(() => {
    resetButtonControlProvider();
  });

  it("reports no provider before registration", () => {
    expect(hasButtonControlProvider()).toBe(false);
  });

  it("THROWS an actionable error when nothing is registered", () => {
    expect(() => requireButtonControlProvider()).toThrow(
      /no button provider is registered/i,
    );
    // The message must name the extension the user has to enable — an error
    // that only says "unavailable" is not actionable.
    expect(() => requireButtonControlProvider()).toThrow(/Controls extension/);
  });

  it("returns the registered provider and reports availability", async () => {
    const seen: CreateButtonControlRequest[] = [];
    registerButtonControlProvider(fakeProvider((r) => seen.push(r)));

    expect(hasButtonControlProvider()).toBe(true);
    const handle = await requireButtonControlProvider().createButton({
      sheetIndex: 2,
      row: 4,
      col: 1,
      label: "Macro1245",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("Macro1245");
    // The instanceId comes BACK from the provider — callers must never derive it.
    expect(handle.instanceId).toBe("control-2-4-1");
  });

  it("unregistering clears the provider", () => {
    const off = registerButtonControlProvider(fakeProvider());
    expect(hasButtonControlProvider()).toBe(true);
    off();
    expect(hasButtonControlProvider()).toBe(false);
    expect(() => requireButtonControlProvider()).toThrow();
  });

  it("a stale cleanup cannot blank out a newer provider", () => {
    const first = fakeProvider();
    const offFirst = registerButtonControlProvider(first);
    const second = fakeProvider();
    registerButtonControlProvider(second);

    offFirst(); // the OLD activation's cleanup runs after a re-activation
    expect(hasButtonControlProvider()).toBe(true);
    expect(requireButtonControlProvider()).toBe(second);
  });

  it("last registration wins", async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerButtonControlProvider(fakeProvider(a));
    registerButtonControlProvider(fakeProvider(b));

    await requireButtonControlProvider().createButton({
      sheetIndex: 0,
      row: 0,
      col: 0,
      label: "x",
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Page Navigator contract (WP-B S3, D-NAV)
// ============================================================================

/**
 * THE SHARED WIRE FIXTURE. Copied VERBATIM into
 * `core/calcula-format/src/page_navigator.rs` (`the_wire_round_trips_the_ts_serializers_bytes`):
 * a `.calp` pull re-serialises `pageOverrides` in Rust and a push must give the published bytes back,
 * so the two serialisers must agree byte for byte. It carries every field, an empty id, a quote, a
 * backslash and a non-ASCII letter (both serialisers write UTF-8 raw and escape only the quote, the
 * backslash and control characters). Change it here and there together.
 */
const PAGE_OVERRIDES_WIRE_FIXTURE = String.raw`[{"sheetId":"7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f","sheetName":"Sales","text":"Overview","hidden":false,"fill":"#ffcc00","color":"#123","borderColor":"#11223344"},{"sheetId":"","sheetName":"Détail \"Q1\" \\ 2026","hidden":true}]`;

const PAGE_OVERRIDES_WIRE_LIST: PageNavigatorOverride[] = [
  {
    sheetId: "7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f",
    sheetName: "Sales",
    text: "Overview",
    hidden: false,
    fill: "#ffcc00",
    color: "#123",
    borderColor: "#11223344",
  },
  { sheetId: "", sheetName: 'Détail "Q1" \\ 2026', hidden: true },
];

/** A strictly valid 256-entry overrides value of EXACTLY `target` characters. */
function overridesOfLength(target: number): string {
  const list: PageNavigatorOverride[] = Array.from({ length: MAX_PAGE_NAVIGATOR_OVERRIDES }, (_, i) => ({
    sheetId: "",
    sheetName: `P${i}`,
    text: "",
  }));
  let missing = target - [...serializePageNavigatorOverrides(list)].length;
  for (const entry of list) {
    if (missing <= 0) break;
    const add = Math.min(MAX_PAGE_NAVIGATOR_CAPTION, missing);
    entry.text = "x".repeat(add);
    missing -= add;
  }
  const value = serializePageNavigatorOverrides(list);
  expect([...value].length).toBe(target);
  return value;
}

describe("page navigator: constants", () => {
  it("pins the wire names Rust mirrors", () => {
    expect(PAGE_NAVIGATOR_CONTROL_TYPE).toBe("pageNavigator");
    expect(PAGE_NAVIGATOR_OVERRIDES_PROPERTY).toBe("pageOverrides");
    expect([...PAGE_NAVIGATOR_ORIENTATIONS]).toEqual(["horizontal", "vertical"]);
    // Mirror of Rust's MAX_CONTROL_PROPERTY_CHARS (held_button_code_tests reads this file's text).
    expect(MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS).toBe(65536);
  });

  it("natural size: n = max(1, count) items of 112 px, 8 px apart, 32 px tall", () => {
    expect(PAGE_NAVIGATOR_NATURAL_ITEM).toEqual({ width: 112, height: 32, gap: 8 });
    expect(pageNavigatorNaturalSize(0)).toEqual({ width: 112, height: 32 });
    expect(pageNavigatorNaturalSize(1)).toEqual({ width: 112, height: 32 });
    expect(pageNavigatorNaturalSize(4)).toEqual({ width: 472, height: 32 });
    expect(pageNavigatorNaturalSize(Number.NaN)).toEqual({ width: 112, height: 32 });
    expect(pageNavigatorNaturalSize(-3)).toEqual({ width: 112, height: 32 });
  });

  it("the default size IS the natural size of four items (never re-typed)", () => {
    expect({ ...PAGE_NAVIGATOR_DEFAULT_SIZE }).toEqual(pageNavigatorNaturalSize(4));
    expect(PAGE_NAVIGATOR_DEFAULT_SIZE).toEqual({ width: 472, height: 32 });
  });
});

describe("page navigator: parsePageNavigatorOverrides (tolerant)", () => {
  it("bad JSON, a non-array and an empty value all read as no overrides", () => {
    expect(parsePageNavigatorOverrides("{not json")).toEqual([]);
    expect(parsePageNavigatorOverrides('{"sheetId":"a","sheetName":"A"}')).toEqual([]);
    expect(parsePageNavigatorOverrides('"text"')).toEqual([]);
    expect(parsePageNavigatorOverrides("5")).toEqual([]);
    expect(parsePageNavigatorOverrides("null")).toEqual([]);
    expect(parsePageNavigatorOverrides("")).toEqual([]);
    expect(parsePageNavigatorOverrides(null)).toEqual([]);
    expect(parsePageNavigatorOverrides(undefined)).toEqual([]);
  });

  it("drops unknown fields, and entries that name no page or are not objects", () => {
    const value = JSON.stringify([
      { sheetId: "a", sheetName: "A", target: "elsewhere", onSelect: "run()" },
      { text: "orphan" },
      { sheetId: "", sheetName: "" },
      "not an object",
      null,
      [1, 2],
      { sheetId: 42, sheetName: "B" },
    ]);
    expect(parsePageNavigatorOverrides(value)).toEqual([
      { sheetId: "a", sheetName: "A" },
      { sheetId: "", sheetName: "B" },
    ]);
  });

  it("drops a bad colour field-wise and keeps the rest of the entry", () => {
    const value = JSON.stringify([
      { sheetId: "a", sheetName: "A", fill: "red", color: "#0a0", borderColor: "#12345", hidden: "yes", text: "Go" },
    ]);
    expect(parsePageNavigatorOverrides(value)).toEqual([
      { sheetId: "a", sheetName: "A", color: "#0a0", text: "Go" },
    ]);
  });

  it("clips a caption to the limit, counting characters (never splitting a surrogate pair)", () => {
    const long = JSON.stringify([{ sheetId: "a", sheetName: "A", text: "y".repeat(400) }]);
    expect(parsePageNavigatorOverrides(long)[0].text).toBe("y".repeat(MAX_PAGE_NAVIGATOR_CAPTION));
    const astral = JSON.stringify([{ sheetId: "a", sheetName: "A", text: "\u{1F600}".repeat(300) }]);
    const clipped = parsePageNavigatorOverrides(astral)[0].text ?? "";
    expect([...clipped].length).toBe(MAX_PAGE_NAVIGATOR_CAPTION);
    expect(clipped).toBe("\u{1F600}".repeat(MAX_PAGE_NAVIGATOR_CAPTION));
  });

  it("keeps at most MAX_PAGE_NAVIGATOR_OVERRIDES entries", () => {
    const value = JSON.stringify(
      Array.from({ length: MAX_PAGE_NAVIGATOR_OVERRIDES + 10 }, (_, i) => ({ sheetId: `s${i}`, sheetName: `P${i}` })),
    );
    const parsed = parsePageNavigatorOverrides(value);
    expect(parsed).toHaveLength(MAX_PAGE_NAVIGATOR_OVERRIDES);
    expect(parsed[0].sheetId).toBe("s0");
    expect(parsed[MAX_PAGE_NAVIGATOR_OVERRIDES - 1].sheetId).toBe(`s${MAX_PAGE_NAVIGATOR_OVERRIDES - 1}`);
  });
});

describe("page navigator: checkPageNavigatorOverrides (strict)", () => {
  it("accepts a valid array, the empty array and the shared fixture", () => {
    expect(checkPageNavigatorOverrides("[]")).toBeNull();
    expect(checkPageNavigatorOverrides(PAGE_OVERRIDES_WIRE_FIXTURE)).toBeNull();
    expect(checkPageNavigatorOverrides(JSON.stringify([{ sheetId: "a", sheetName: "" }]))).toBeNull();
    expect(checkPageNavigatorOverrides(JSON.stringify([{ sheetId: "", sheetName: "A" }]))).toBeNull();
  });

  it("refuses text that is not a JSON array", () => {
    expect(checkPageNavigatorOverrides("{oops")).toMatch(/not valid JSON/);
    expect(checkPageNavigatorOverrides('{"sheetId":"a","sheetName":"A"}')).toMatch(/must be a JSON array/);
  });

  it("refuses more than MAX_PAGE_NAVIGATOR_OVERRIDES entries", () => {
    const value = JSON.stringify(
      Array.from({ length: MAX_PAGE_NAVIGATOR_OVERRIDES + 1 }, (_, i) => ({ sheetId: `s${i}`, sheetName: "" })),
    );
    expect(checkPageNavigatorOverrides(value)).toMatch(/name 257 pages; a page navigator keeps at most 256/);
  });

  it("names the offending entry by position and page", () => {
    const value = JSON.stringify([
      { sheetId: "a", sheetName: "Sales" },
      { sheetId: "b", sheetName: "Detail", fill: "red" },
    ]);
    const why = checkPageNavigatorOverrides(value) ?? "";
    expect(why).toMatch(/Page button setting 2 \(page "Detail"\)/);
    expect(why).toMatch(/fill "red" is not a colour/);
  });

  it("refuses each malformed field with a sentence", () => {
    const one = (entry: unknown) => checkPageNavigatorOverrides(JSON.stringify([entry]));
    expect(one("Sales")).toMatch(/setting 1 must be an object/);
    expect(one({ sheetId: "a", sheetName: "A", target: "x" })).toMatch(/unknown field "target"/);
    expect(one({ sheetId: "a" })).toMatch(/text sheetId and sheetName/);
    expect(one({ sheetId: 7, sheetName: "A" })).toMatch(/text sheetId and sheetName/);
    expect(one({ sheetId: "", sheetName: "" })).toMatch(/names no page/);
    expect(one({ sheetId: "a", sheetName: "A", text: 5 })).toMatch(/caption \(text\) must be text/);
    expect(one({ sheetId: "a", sheetName: "A", text: "z".repeat(MAX_PAGE_NAVIGATOR_CAPTION + 1) })).toMatch(
      /caption is 256 characters; the limit is 255/,
    );
    expect(one({ sheetId: "a", sheetName: "A", hidden: "yes" })).toMatch(/hidden must be true or false/);
    expect(one({ sheetId: "a", sheetName: "A", borderColor: "#12345" })).toMatch(/borderColor "#12345" is not a colour/);
    expect(one({ sheetId: "a", sheetName: "A", color: 0 })).toMatch(/color 0 is not a colour/);
  });

  it("counts a caption in characters, as Rust does", () => {
    const astral = JSON.stringify([
      { sheetId: "a", sheetName: "A", text: "\u{1F600}".repeat(MAX_PAGE_NAVIGATOR_CAPTION) },
    ]);
    expect(checkPageNavigatorOverrides(astral)).toBeNull();
  });

  it("refuses the TOTAL past the backend's 64 KiB door, with the length sentence", () => {
    // Every entry is valid on its own (256 entries x 255-char captions) -- only the total is too long.
    const full = serializePageNavigatorOverrides(
      Array.from({ length: MAX_PAGE_NAVIGATOR_OVERRIDES }, (_, i) => ({
        sheetId: `s${i}`,
        sheetName: `Page ${i}`,
        text: "x".repeat(MAX_PAGE_NAVIGATOR_CAPTION),
      })),
    );
    expect([...full].length).toBeGreaterThan(MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS);
    expect(checkPageNavigatorOverrides(full)).toBe(
      `The per-page button settings are ${[...full].length} characters; the limit is 65536. ` +
        "Shorten some captions or clear settings you no longer need.",
    );
  });

  it("passes a value of exactly the cap and refuses one character more", () => {
    expect(checkPageNavigatorOverrides(overridesOfLength(MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS))).toBeNull();
    expect(checkPageNavigatorOverrides(overridesOfLength(MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS + 1))).toMatch(
      /are 65537 characters; the limit is 65536/,
    );
  });
});

describe("page navigator: serializePageNavigatorOverrides (canonical)", () => {
  it("writes the fixed key order whatever order the object was built in", () => {
    const scrambled = {
      borderColor: "#111",
      hidden: true,
      color: "#222",
      text: "T",
      fill: "#333",
      sheetName: "N",
      sheetId: "I",
    } as PageNavigatorOverride;
    expect(serializePageNavigatorOverrides([scrambled])).toBe(
      '[{"sheetId":"I","sheetName":"N","text":"T","hidden":true,"fill":"#333","color":"#222","borderColor":"#111"}]',
    );
  });

  it("omits undefined fields and writes [] for none", () => {
    expect(serializePageNavigatorOverrides([])).toBe("[]");
    expect(serializePageNavigatorOverrides([{ sheetId: "a", sheetName: "A", text: undefined }])).toBe(
      '[{"sheetId":"a","sheetName":"A"}]',
    );
  });

  it("emits the SHARED WIRE FIXTURE byte for byte (Rust pins the same string)", () => {
    expect(serializePageNavigatorOverrides(PAGE_OVERRIDES_WIRE_LIST)).toBe(PAGE_OVERRIDES_WIRE_FIXTURE);
  });

  it("round-trips: parse(fixture) is the list, and serialize(parse(x)) === x", () => {
    expect(parsePageNavigatorOverrides(PAGE_OVERRIDES_WIRE_FIXTURE)).toEqual(PAGE_OVERRIDES_WIRE_LIST);
    expect(serializePageNavigatorOverrides(parsePageNavigatorOverrides(PAGE_OVERRIDES_WIRE_FIXTURE))).toBe(
      PAGE_OVERRIDES_WIRE_FIXTURE,
    );
  });
});

describe("page navigator: matchPageNavigatorOverride (the one matching rule)", () => {
  const PAGES = [
    { sheetId: "A", name: "Sales" },
    { sheetId: "B", name: "Detail" },
  ];

  it("1. by sheetId first, over a name match", () => {
    const byName: PageNavigatorOverride = { sheetId: "gone", sheetName: "Sales", text: "by name" };
    const byId: PageNavigatorOverride = { sheetId: "A", sheetName: "Old name", text: "by id" };
    expect(matchPageNavigatorOverride([byName, byId], PAGES[0], PAGES)).toBe(byId);
  });

  it("2. by exact name when the override's id names no live page (a subscriber's ids)", () => {
    const o: PageNavigatorOverride = { sheetId: "app-id", sheetName: "Detail" };
    expect(matchPageNavigatorOverride([o], PAGES[1], PAGES)).toBe(o);
    const noId: PageNavigatorOverride = { sheetId: "", sheetName: "Detail" };
    expect(matchPageNavigatorOverride([noId], PAGES[1], PAGES)).toBe(noId);
    // A page with no id of its own is matched by name too.
    expect(matchPageNavigatorOverride([o], { name: "Detail" }, PAGES)).toBe(o);
  });

  it("3. case-folded name last; an exact name wins over a folded one", () => {
    const folded: PageNavigatorOverride = { sheetId: "gone", sheetName: "DETAIL" };
    expect(matchPageNavigatorOverride([folded], PAGES[1], PAGES)).toBe(folded);
    const exact: PageNavigatorOverride = { sheetId: "gone2", sheetName: "Detail" };
    expect(matchPageNavigatorOverride([folded, exact], PAGES[1], PAGES)).toBe(exact);
  });

  it("an override whose id matches ANOTHER live page never applies by name", () => {
    // Sales's override was written when Sales was called "Detail"; the page now called Detail must not take it.
    const salesOverride: PageNavigatorOverride = { sheetId: "A", sheetName: "Detail", text: "Sales!" };
    expect(matchPageNavigatorOverride([salesOverride], PAGES[1], PAGES)).toBeUndefined();
    expect(matchPageNavigatorOverride([salesOverride], PAGES[0], PAGES)).toBe(salesOverride);
  });

  it("no override applies -> undefined", () => {
    expect(matchPageNavigatorOverride([], PAGES[0], PAGES)).toBeUndefined();
    expect(
      matchPageNavigatorOverride([{ sheetId: "gone", sheetName: "Elsewhere" }], PAGES[0], PAGES),
    ).toBeUndefined();
  });
});

describe("page navigator: checkCreatePageNavigator", () => {
  it("accepts an anchor, a position, both, and a known orientation", () => {
    expect(checkCreatePageNavigator({ sheetIndex: 0, row: 2, col: 3 })).toBeNull();
    expect(checkCreatePageNavigator({ sheetIndex: 1, x: 10, y: 20, width: 300, height: 40 })).toBeNull();
    expect(checkCreatePageNavigator({ sheetIndex: 1, row: 0, col: 0, x: 0, y: 0, orientation: "vertical" })).toBeNull();
  });

  it("refuses an unknown orientation", () => {
    const req = { sheetIndex: 0, row: 0, col: 0, orientation: "diagonal" } as unknown as CreatePageNavigatorRequest;
    expect(checkCreatePageNavigator(req)).toMatch(/Unknown page navigator orientation "diagonal".*horizontal, vertical/);
  });

  it("refuses x without y (and y without x)", () => {
    expect(checkCreatePageNavigator({ sheetIndex: 0, x: 5 } as unknown as CreatePageNavigatorRequest)).toMatch(
      /needs both x and y/,
    );
    expect(checkCreatePageNavigator({ sheetIndex: 0, y: 5 } as unknown as CreatePageNavigatorRequest)).toMatch(
      /needs both x and y/,
    );
  });

  it("refuses negative or non-finite positions and half an anchor", () => {
    expect(checkCreatePageNavigator({ sheetIndex: 0, x: -1, y: 5 })).toMatch(/non-negative, finite/);
    expect(checkCreatePageNavigator({ sheetIndex: 0, x: Number.NaN, y: 5 })).toMatch(/non-negative, finite/);
    expect(checkCreatePageNavigator({ sheetIndex: 0, row: 1 } as unknown as CreatePageNavigatorRequest)).toMatch(
      /needs both row and col/,
    );
    expect(checkCreatePageNavigator({ sheetIndex: 0, row: 1.5, col: 0 })).toMatch(/whole row and column/);
  });

  it("refuses a request that says neither where nor which sheet", () => {
    expect(checkCreatePageNavigator({ sheetIndex: 0 } as unknown as CreatePageNavigatorRequest)).toMatch(
      /gave neither/,
    );
    expect(checkCreatePageNavigator({ sheetIndex: -1, row: 0, col: 0 })).toMatch(/sheetIndex/);
  });

  it("refuses negative, zero and non-finite sizes", () => {
    const at = { sheetIndex: 0, row: 0, col: 0 };
    expect(checkCreatePageNavigator({ ...at, width: -10 })).toMatch(/width must be a positive number/);
    expect(checkCreatePageNavigator({ ...at, width: 0 })).toMatch(/width must be a positive number/);
    expect(checkCreatePageNavigator({ ...at, height: Number.POSITIVE_INFINITY })).toMatch(
      /height must be a positive number/,
    );
    expect(checkCreatePageNavigator({ ...at, height: Number.NaN })).toMatch(/height must be a positive number/);
  });

  it("the registered provider's createPageNavigator is reachable through the seam", async () => {
    resetButtonControlProvider();
    registerButtonControlProvider(fakeProvider());
    const handle = await requireButtonControlProvider().createPageNavigator({ sheetIndex: 3, x: 16, y: 16 });
    expect(handle.instanceId).toBe("control-3-nav");
    expect(handle.width).toBe(PAGE_NAVIGATOR_DEFAULT_SIZE.width);
  });
});
