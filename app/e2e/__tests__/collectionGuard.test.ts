//! FILENAME: app/e2e/__tests__/collectionGuard.test.ts
// PURPOSE: Unit tier for the collection guard -- the check that fails a run
//          whose collected test set disagrees with `--list` for the same
//          filter (docs/design/open-decisions-2026-08.md §15e finding 2: a
//          journey pass collected 134 of 143 tests and reported a clean pass).
//
// EVERY GUARD IN THIS HARNESS HAS A FIRING SELF-TEST, and this file carries the
// guard's: a fabricated 9-test shortfall must produce a verdict that NAMES the
// missing files, and an agreeing pair must produce none. A guard whose failure
// path was never exercised is the shape this program keeps deleting.

import { describe, it, expect } from "vitest";
import {
  testIdentity,
  listedIdentities,
  compareCollections,
  describeCollectionShortfall,
  listArgsFrom,
  skipFlagIn,
  assertCollectionGuardPresent,
  globToRegex,
  matchedSpecFiles,
  describeZeroTestFiles,
  canonPath,
} from "../collectionGuard";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test/reporter";

// ---------------------------------------------------------------------------
// listedIdentities: flattening the --list --reporter=json shape
// ---------------------------------------------------------------------------

/** A minimal but structurally faithful JSON-reporter listing. */
const LISTING = {
  config: {},
  suites: [
    {
      title: "journeys\\sheet-tab-state-undo.spec.ts",
      file: "journeys\\sheet-tab-state-undo.spec.ts",
      specs: [],
      suites: [
        {
          title: "BUG-0050 hide-undo",
          file: "journeys\\sheet-tab-state-undo.spec.ts",
          specs: [
            {
              title: "undo reverses a hide",
              file: "journeys\\sheet-tab-state-undo.spec.ts",
              tests: [{ projectName: "journey" }],
            },
            {
              title: "undo returns to the hidden sheet",
              file: "journeys\\sheet-tab-state-undo.spec.ts",
              tests: [{ projectName: "journey" }],
            },
          ],
        },
      ],
    },
    {
      title: "journeys\\dirty-flag.spec.ts",
      file: "journeys\\dirty-flag.spec.ts",
      specs: [
        {
          title: "an edit dirties the title bar",
          file: "journeys\\dirty-flag.spec.ts",
          tests: [{ projectName: "journey" }],
        },
      ],
      suites: [],
    },
  ],
};

describe("listedIdentities", () => {
  it("flattens file suites, describe suites and per-project tests", () => {
    const ids = listedIdentities(LISTING);
    expect(ids).toHaveLength(3);
    expect(ids).toContain(
      "[journey] journeys/sheet-tab-state-undo.spec.ts :: BUG-0050 hide-undo > undo reverses a hide",
    );
    expect(ids).toContain(
      "[journey] journeys/sheet-tab-state-undo.spec.ts :: BUG-0050 hide-undo > undo returns to the hidden sheet",
    );
    expect(ids).toContain(
      "[journey] journeys/dirty-flag.spec.ts :: an edit dirties the title bar",
    );
  });

  it("normalises backslashes so both sides of the comparison agree", () => {
    expect(testIdentity("p", "a\\b.spec.ts", ["t"])).toBe(
      "[p] a/b.spec.ts :: t",
    );
  });

  it("throws on output that is not a listing at all", () => {
    expect(() => listedIdentities({ nope: true })).toThrow(/no `suites` array/);
  });

  // The scenario project registers every test through scenarios/lib/scenario.ts,
  // so `spec.file` names the LIB while the run side's titlePath()[2] names the
  // spec file the runner imported. The identity must follow the FILE-SUITE
  // title (= the spec file), or the guard fails every scenario run as
  // "N missing + N phantom" over identical test sets — measured live on the
  // first scenario run through the guard, 2026-08-14.
  it("lib-registered tests take the file-suite title, not spec.file", () => {
    const libListing = {
      config: {},
      suites: [
        {
          title: "scenarios\\budget-model.scenario.ts",
          file: "scenarios\\budget-model.scenario.ts",
          specs: [],
          suites: [
            {
              title: "Scenario: budget-model",
              file: "scenarios\\lib\\scenario.ts",
              specs: [
                {
                  title: "00 reset workbook",
                  file: "scenarios\\lib\\scenario.ts",
                  tests: [{ projectName: "scenario" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(listedIdentities(libListing)).toEqual([
      "[scenario] scenarios/budget-model.scenario.ts :: Scenario: budget-model > 00 reset workbook",
    ]);
  });

  // The fallback: a listing whose file-suite title is empty still yields a
  // usable identity from spec.file rather than an empty file component.
  it("falls back to spec.file when the file-suite title is empty", () => {
    const listing = {
      config: {},
      suites: [
        {
          title: "",
          file: "tests\\x.spec.ts",
          specs: [
            {
              title: "t",
              file: "tests\\x.spec.ts",
              tests: [{ projectName: "functional" }],
            },
          ],
          suites: [],
        },
      ],
    };
    expect(listedIdentities(listing)).toEqual([
      "[functional] tests/x.spec.ts :: t",
    ]);
  });
});

// ---------------------------------------------------------------------------
// compareCollections + describeCollectionShortfall
// ---------------------------------------------------------------------------

describe("compareCollections", () => {
  const A = "[journey] journeys/a.spec.ts :: t1";
  const B = "[journey] journeys/b.spec.ts :: t2";
  const C = "[journey] journeys/c.spec.ts :: t3";

  it("agreeing multisets produce no verdict", () => {
    const cmp = compareCollections([A, B], [B, A]);
    expect(cmp.missing).toEqual([]);
    expect(cmp.phantom).toEqual([]);
    expect(describeCollectionShortfall(cmp)).toBeNull();
  });

  it("FIRES on the observed failure shape: listed tests the run never collected", () => {
    const cmp = compareCollections([A, B, C], [A]);
    expect(cmp.missing).toEqual([B, C].sort());
    expect(cmp.phantom).toEqual([]);
    const verdict = describeCollectionShortfall(cmp);
    expect(verdict).not.toBeNull();
    // The verdict must NAME the missing files -- that is its whole value.
    expect(verdict).toContain("journeys/b.spec.ts");
    expect(verdict).toContain("journeys/c.spec.ts");
    expect(verdict).toContain("3 test(s)");
    expect(verdict).toContain("collected 1");
    expect(verdict).toContain("NOT collected");
  });

  it("fires on phantom tests too (collected but not listed)", () => {
    const cmp = compareCollections([A], [A, C]);
    expect(cmp.missing).toEqual([]);
    expect(cmp.phantom).toEqual([C]);
    const verdict = describeCollectionShortfall(cmp);
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("NOT in the listing");
    expect(verdict).toContain("journeys/c.spec.ts");
  });

  it("treats duplicate identities as a multiset, not a set", () => {
    // Two identically-titled tests (e.g. generated) must balance one-to-one.
    const cmp = compareCollections([A, A], [A]);
    expect(cmp.missing).toEqual([A]);
    expect(describeCollectionShortfall(cmp)).toContain("journeys/a.spec.ts");
  });
});

// ---------------------------------------------------------------------------
// CLI argument handling for the child --list invocation
// ---------------------------------------------------------------------------

describe("listArgsFrom", () => {
  it("keeps the filter and strips reporters/snapshot flags in both value forms", () => {
    expect(
      listArgsFrom([
        "test",
        "--project=journey",
        "--reporter=dot,json",
        "--grep",
        "BUG-0043",
        "-u",
        "--update-snapshots=changed",
        "e2e/tests/scrolling.spec.ts",
      ]),
    ).toEqual([
      "--project=journey",
      "--grep",
      "BUG-0043",
      "e2e/tests/scrolling.spec.ts",
    ]);
  });

  it("strips a separate-value --reporter together with its value", () => {
    expect(listArgsFrom(["test", "--reporter", "dot", "--project=visual"])).toEqual([
      "--project=visual",
    ]);
  });
});

describe("skipFlagIn", () => {
  it("names the flag that makes the comparison undefined", () => {
    expect(skipFlagIn(["--project=journey", "--shard=1/2"])).toBe("--shard");
    expect(skipFlagIn(["--last-failed"])).toBe("--last-failed");
    expect(skipFlagIn(["--project=journey"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spec-file coverage: the empty-file mechanism, REPRODUCED 2026-08-14
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("handles the shapes this config uses", () => {
    expect(globToRegex("**/*.spec.ts").test("a.spec.ts")).toBe(true);
    expect(globToRegex("**/*.spec.ts").test("sub/dir/a.spec.ts")).toBe(true);
    expect(globToRegex("**/*.spec.ts").test("a.test.ts")).toBe(false);
    expect(globToRegex("**/*.spec.ts").test("__screenshots__/x/a.png")).toBe(false);
    expect(globToRegex("**/state-consistency.spec.ts").test("state-consistency.spec.ts")).toBe(true);
    expect(globToRegex("**/state-consistency.spec.ts").test("other.spec.ts")).toBe(false);
    expect(globToRegex("**/*.scenario.ts").test("lib/scenario.ts")).toBe(false);
    expect(globToRegex("**/*.scenario.ts").test("month-close.scenario.ts")).toBe(true);
  });
});

describe("matchedSpecFiles", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  it("claims exactly the journey specs the listing reports (the real tree)", () => {
    const files = matchedSpecFiles({
      testDir: path.resolve(HERE, "..", "journeys"),
      testMatch: "**/*.spec.ts",
      testIgnore: [],
    });
    expect(files.length).toBeGreaterThanOrEqual(29);
    expect(files.every((f) => f.endsWith(".spec.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("sheet-tab-state-undo.spec.ts"))).toBe(true);
  });

  it("honours testIgnore the way the functional project does", () => {
    const testDir = path.resolve(HERE, "..", "tests");
    const files = matchedSpecFiles({
      testDir,
      testMatch: "**/*.spec.ts",
      testIgnore: "**/state-consistency.spec.ts",
    });
    expect(files.some((f) => f.endsWith("state-consistency.spec.ts"))).toBe(false);
    expect(files.some((f) => f.endsWith("scrolling.spec.ts"))).toBe(true);
  });
});

describe("describeZeroTestFiles", () => {
  const f1 = canonPath("C:/repo/app/e2e/journeys/a.spec.ts");
  const f2 = canonPath("C:/repo/app/e2e/journeys/b.spec.ts");
  const lib = canonPath("C:/repo/app/e2e/scenarios/lib/scenario.ts");

  it("is silent when every matched file contributes tests", () => {
    const r = describeZeroTestFiles("journey", [f1, f2], [], new Set([f1, f2]));
    expect(r.message).toBeNull();
    expect(r.note).toBeNull();
  });

  it("FIRES unconditionally on a zero-byte matched file (the reproduced mechanism)", () => {
    const r = describeZeroTestFiles("journey", [f1, f2], [f2], new Set([f1, f2]));
    expect(r.message).not.toBeNull();
    expect(r.message).toContain("b.spec.ts");
    expect(r.message).toContain("EMPTY (0 bytes)");
    expect(r.message).toContain("truncate");
  });

  it("FIRES on a matched file contributing zero tests when attribution is direct", () => {
    const r = describeZeroTestFiles("journey", [f1, f2], [], new Set([f1]));
    expect(r.message).not.toBeNull();
    expect(r.message).toContain("b.spec.ts");
    expect(r.message).toContain("ZERO tests");
  });

  it("declines the coverage claim, with a note, for indirect registration (the scenario shape)", () => {
    // All 24 scenario tests are attributed to lib/scenario.ts, which is not a
    // matched file -- coverage is undecidable and must not false-alarm.
    const s1 = canonPath("C:/repo/app/e2e/scenarios/budget-model.scenario.ts");
    const s2 = canonPath("C:/repo/app/e2e/scenarios/data-cleanup.scenario.ts");
    const r = describeZeroTestFiles("scenario", [s1, s2], [], new Set([lib]));
    expect(r.message).toBeNull();
    expect(r.note).toContain("undecidable");
    expect(r.note).toContain("scenario");
  });
});

// ---------------------------------------------------------------------------
// The global-setup handshake: a run that lost the guard must refuse to start
// ---------------------------------------------------------------------------

describe("assertCollectionGuardPresent", () => {
  const cfg = (reporter: Array<[string] | [string, unknown]>): FullConfig =>
    ({ reporter }) as unknown as FullConfig;

  it("accepts a reporter list that carries the guard (config or CLI path form)", () => {
    expect(() =>
      assertCollectionGuardPresent(cfg([["./e2e/collectionGuard.ts"], ["list"]])),
    ).not.toThrow();
    expect(() =>
      assertCollectionGuardPresent(
        cfg([["C:\\repo\\app\\e2e\\collectionGuard.ts", {}], ["dot"], ["json"]]),
      ),
    ).not.toThrow();
  });

  it("FIRES on the standard --reporter=dot,json override that would drop the guard", () => {
    expect(() =>
      assertCollectionGuardPresent(cfg([["dot"], ["json"]])),
    ).toThrow(/collection guard/);
  });
});
