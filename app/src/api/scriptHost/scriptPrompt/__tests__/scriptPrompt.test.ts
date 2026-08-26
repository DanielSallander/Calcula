//! FILENAME: app/src/api/scriptHost/scriptPrompt/__tests__/scriptPrompt.test.ts
// PURPOSE: Pin the two properties the budget assembler exists for — it never
//          exceeds the budget it was given, and it never truncates in silence.
// CONTEXT: §4d. The silent-truncation case is the one worth guarding hardest: a
//          partial surface the model is not told about is indistinguishable to it
//          from a small API, so it invents the missing method, L1 rejects the
//          invention, and the repair loop burns its rounds rediscovering the gap.

import { describe, it, expect } from "vitest";
import {
  buildSurfacePrompt,
  fullSurfaceCost,
  rankSurface,
  hintTerms,
  SURFACE_ENTRIES,
  SHARED_IFACES,
  OWN_CHAINS_BY_OBJECT_TYPE,
  REACHABLE_CHAINS_BY_OBJECT_TYPE,
  ROOT_IFACE_BY_OBJECT_TYPE,
  chainsForObjectType,
  entriesForObjectType,
} from "../index";

describe("the generated slices are present and sane", () => {
  it("is not empty (every budget assertion would pass vacuously)", () => {
    expect(SURFACE_ENTRIES.length).toBeGreaterThan(500);
  });

  it("covers every object type a draft can target", () => {
    // drafts.rs validates 16 types; the probe's table is the source here and
    // carries chartMark too. What matters is that a draft target has a slice.
    for (const t of ["workbook", "sheet", "cell", "button", "chart", "pivot", "table", "range"]) {
      expect(chainsForObjectType(t).length, `${t} has no slice`).toBeGreaterThan(50);
    }
  });

  it("gives every entry a one-line signature", () => {
    for (const e of SURFACE_ENTRIES) {
      expect(e.signature, `${e.chain} has no signature`).not.toBe("");
      expect(e.signature, `${e.chain} signature spans lines`).not.toContain("\n");
      expect(e.cost).toBeGreaterThan(0);
    }
  });

  it("is dramatically smaller than the .d.ts it is derived from", () => {
    // The whole point of M4. objectContexts.d.ts is ~96,800 estimated tokens;
    // if this ever stops holding, the slices have started carrying prose again.
    expect(fullSurfaceCost("button")).toBeLessThan(40_000);
  });
});

describe("the budget is never exceeded", () => {
  it.each([500, 1_000, 4_000, 12_000, 100_000])("holds at a %i-token budget", (budget) => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: budget });
    expect(r.costTokens).toBeLessThanOrEqual(budget);
  });

  it("fits an 8k-context model's realistic share, which the full slice does not", () => {
    const full = fullSurfaceCost("button");
    expect(full, "the full slice should NOT fit — that is why this module exists").toBeGreaterThan(4_000);
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 4_000 });
    expect(r.costTokens).toBeLessThanOrEqual(4_000);
    expect(r.includedChains.length).toBeGreaterThan(30);
    expect(r.truncated).toBe(true);
  });

  it("returns empty rather than a half-written signature when nothing fits", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 5 });
    expect(r.text).toBe("");
    expect(r.includedChains).toEqual([]);
    // A truncated-to-nothing surface still reports the omission honestly.
    expect(r.omittedCount).toBeGreaterThan(0);
  });

  it("carries the whole surface, untruncated, when the budget is generous", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 200_000 });
    expect(r.truncated).toBe(false);
    expect(r.omittedCount).toBe(0);
    expect(r.text).not.toContain("did not fit");
  });
});

describe("truncation is announced, never silent", () => {
  it("names the number omitted and forbids guessing", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 3_000 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain(`${r.omittedCount} further methods exist`);
    expect(r.text).toMatch(/do NOT guess a name/);
  });

  it("tells the model a listed-only rule even when nothing was dropped", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 200_000 });
    expect(r.text).toMatch(/do not invent one/);
  });
});

describe("priority decides what survives", () => {
  it("never drops the object's own members, even at a tight budget", () => {
    // They are the reason the script is attached to this object at all. Asserted
    // as "all present" rather than "strictly first": the top bucket also holds
    // the core set and the capability index, and their relative order inside it
    // does not matter to a model.
    const own = rankSurface("button").filter((e) => e.group === "context").map((e) => e.chain);
    expect(own.length).toBeGreaterThan(5);
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 2_000 });
    expect(own.filter((c) => !r.includedChains.includes(c))).toEqual([]);
  });

  it("always shows that each capability namespace EXISTS, even unhinted", () => {
    // The failure this prevents, measured: a task saying "Get JSON from
    // https://..." matches nothing in `caps.fetch`'s chain or prose, so it
    // ranked 468th of 528 and a model asked to download something was given no
    // evidence that downloading is possible. It then invents `fetch()`.
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 2_000 });
    expect(r.includedChains).toContain("caps.fetch");
    expect(r.includedChains).toContain("caps.storage.get");
  });

  it("promotes a hinted member that is NOT the capability's representative", () => {
    // `caps.storage.get` is always present as storage's index entry; `set` is
    // not, so it is what actually tests the hint path.
    const tight = 2_000;
    const without = buildSurfacePrompt({ objectType: "button", budgetTokens: tight });
    const withHint = buildSurfacePrompt({ objectType: "button", budgetTokens: tight, hints: ["storage"] });
    expect(without.includedChains).not.toContain("caps.storage.set");
    expect(withHint.includedChains).toContain("caps.storage.set");
  });

  it("drops function words so an innocuous 'and' cannot hoist junk", () => {
    // Measured: the intent "Count how many times this button has been clicked..."
    // put `api.executeCommand` (comm-AND) at the very top of the ranking, ahead
    // of `log` and `expose`.
    expect(hintTerms(["and the has been this how many"])).toEqual([]);
  });

  it("stems a term so 'store' reaches 'storage'", () => {
    // "storage" does not contain "store" — the fifth letter differs — and that
    // single miss ranked both storage methods 517th of 528.
    expect(hintTerms(["store"])).toContain("stor");
  });

  it("a hint does not blow the budget", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 2_000, hints: ["fetch", "storage", "schedule"] });
    expect(r.costTokens).toBeLessThanOrEqual(2_000);
  });

  it("ignores hint fragments too short to mean anything", () => {
    // "to" would substring-match half the surface and rank nothing.
    const a = buildSurfacePrompt({ objectType: "button", budgetTokens: 2_000, hints: ["to", "a"] });
    const b = buildSurfacePrompt({ objectType: "button", budgetTokens: 2_000 });
    expect(a.includedChains).toEqual(b.includedChains);
  });
});

describe("the prompt is stable and readable", () => {
  it("produces byte-identical output for the same request", () => {
    // A prompt that reshuffles makes a repair loop non-reproducible and defeats
    // whatever prefix caching the runtime does.
    const one = buildSurfacePrompt({ objectType: "chart", budgetTokens: 6_000, hints: ["spec"] });
    const two = buildSurfacePrompt({ objectType: "chart", budgetTokens: 6_000, hints: ["spec"] });
    expect(one.text).toBe(two.text);
  });

  it("lists members alphabetically regardless of the order ranking chose", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 6_000, hints: ["fetch"] });
    const listed = [...r.text.matchAll(/^context\.([A-Za-z0-9_.]+)$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...listed].sort());
  });

  it("marks a capability-bearing member with the pragma the script will need", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 40_000 });
    expect(r.includedChains).toContain("caps.fetch");
    expect(r.text).toContain("// @capability net.fetch");
  });

  it("carries no generated policy prose (that is what made the .d.ts unusable)", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 200_000 });
    expect(r.text).not.toContain("Calcula policy (generated)");
    expect(r.text).not.toContain("Reach: broker");
  });
});

describe("an unknown object type degrades to the whole surface", () => {
  it("does not return an empty prompt for a type it has never heard of", () => {
    // Better to over-show than to hand a model an empty API and watch it invent
    // one wholesale.
    const r = buildSurfacePrompt({ objectType: "spaceship", budgetTokens: 8_000 });
    expect(r.includedChains.length).toBeGreaterThan(50);
  });
});

describe("a chain that means different things on different objects", () => {
  /**
   * The rendered signature, which `renderEntry` puts on the line directly after
   * `context.<chain>`. Null when the type is not shown that chain at all.
   */
  function signatureFor(objectType: string, chain: string): string | null {
    const lines = buildSurfacePrompt({ objectType, budgetTokens: 200_000 }).text.split("\n");
    const at = lines.indexOf(`context.${chain}`);
    return at === -1 ? null : lines[at + 1].trim();
  }

  it("shows each object type the getCellValue IT can call", () => {
    // Three declarations, two brokers. The chain-keyed map this replaced kept
    // whichever interface sorted first -- ShapeContext -- so a sheet script was
    // shown an A1-string signature that does not exist on its context, as the
    // ONLY description of the API it may call. The draft then validated clean
    // (the reach check matches by CHAIN and cannot see arity) and did nothing.
    expect(signatureFor("sheet", "getCellValue")).toBe(
      "getCellValue(row: number, col: number, sheet?: SheetRef): Promise<string>",
    );
    expect(signatureFor("shape", "getCellValue")).toBe("getCellValue(cellRef: string): Promise<string>");
    expect(signatureFor("table", "getCellValue")).toBe(
      "getCellValue(row: number, colIndex: number): Promise<string>",
    );
  });

  it("shows each object type the setCellValue IT can call", () => {
    expect(signatureFor("sheet", "setCellValue")).toContain("sheet?: SheetRef");
    expect(signatureFor("table", "setCellValue")).toContain("colIndex: number");
  });

  it("shows a button no getCellValue at all", () => {
    // Declared on ShapeContext, SheetContext and TableContext only. A button
    // cannot reach any of them, and a signature the script cannot call is worse
    // than an absent one under a header promising these are the only methods.
    expect(signatureFor("button", "getCellValue")).toBeNull();
  });
});

describe("resolving per object type stays sound", () => {
  const TYPES = Object.keys(OWN_CHAINS_BY_OBJECT_TYPE);

  it("covers every object type the probe produced", () => {
    // Non-vacuity for the three loops below, which are all it.each over TYPES.
    expect(TYPES.length).toBe(17);
  });

  it.each([...TYPES, "spaceship"])("renders no chain twice for %s", (objectType) => {
    const chains = buildSurfacePrompt({ objectType, budgetTokens: 200_000 }).includedChains;
    expect(chains.filter((c, i) => chains.indexOf(c) !== i)).toEqual([]);
  });

  it.each(TYPES)("resolves exactly one entry per reachable chain for %s", (objectType) => {
    expect(entriesForObjectType(objectType).length).toBe(chainsForObjectType(objectType).length);
  });

  it.each(TYPES)("resolves %s's own declaration, never a stranger's", (objectType) => {
    // `entryFor`'s last arm exists for the unknown-type case. For a KNOWN type
    // it must never be reached: every entry carries either that type's root
    // interface or one whose declarations mean the same thing wherever they are
    // reached from. Measured: the fallback is taken 0 times across all 17.
    const rootIface = ROOT_IFACE_BY_OBJECT_TYPE[objectType];
    const shared = new Set(SHARED_IFACES);
    const strangers = entriesForObjectType(objectType).filter(
      (e) => !e.ifaces.includes(rootIface) && !e.ifaces.some((i) => shared.has(i)),
    );
    expect(strangers.map((e) => `${e.chain} <- ${e.ifaces.join("/")}`)).toEqual([]);
  });
});

describe("a prompt never offers a member the object type cannot reach", () => {
  // A button task's own words, so the ranker is under real hint pressure.
  const HINTS = ["formats", "background", "color", "selected", "cell", "content", "script"];

  it("withholds the whole ScriptRange facet from a button", () => {
    const r = buildSurfacePrompt({ objectType: "button", budgetTokens: 6_000, hints: HINTS });
    // Non-vacuity FIRST: an empty prompt would pass the real assertion trivially.
    expect(r.includedChains.length).toBeGreaterThan(80);
    // `range()` and `cell()` are declared on SheetContext and TableContext
    // alone, so a button script cannot obtain either object. Measured against
    // the artifact before this change: 22 such members in exactly this prompt.
    expect(r.includedChains.filter((c) => c.startsWith("cell.") || c.startsWith("range."))).toEqual([]);
  });

  it("still offers them to a sheet, which can obtain a range", () => {
    const r = buildSurfacePrompt({ objectType: "sheet", budgetTokens: 6_000, hints: HINTS });
    expect(r.includedChains).toContain("range");
    expect(r.includedChains.filter((c) => c.startsWith("range.")).length).toBeGreaterThan(0);
  });

  it("floors the ranker on what the object DECLARES, not on what it can reach", () => {
    // Two different questions, and the ranker's key 0 must keep asking the
    // first: flooring a sheet script's 119 reachable extras would spend the
    // budget before `api.setCellValue`.
    expect(OWN_CHAINS_BY_OBJECT_TYPE.sheet.length).toBe(17);
    expect(REACHABLE_CHAINS_BY_OBJECT_TYPE.sheet.length).toBe(119);
  });
});
