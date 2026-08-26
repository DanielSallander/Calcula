// PURPOSE: THE LOCKSTEP GUARD. Regenerates objectContexts.d.ts from the live
//          worker context shim + the broker allowlist and fails when the
//          committed file differs, or when the shim exposes a member the
//          typings do not declare (or the reverse).
// CONTEXT: objectContexts.d.ts is the ONLY extraLib Monaco loads for object
//          scripts, so it IS Calcula's object browser. Before this test it was
//          hand-maintained and had silently drifted: biQuery, biSql,
//          listBiConnections, cube.*, connector.*, the whole range and chartMark
//          contexts, shape.declareProperties and two invalidate() methods were
//          callable at runtime and invisible to IntelliSense — while
//          shape.render.declareProperties was advertised and did not exist.
//
//          A generator alone would not have prevented that; nothing forces
//          anyone to run it. This test does, on every `npm test`. If it fails
//          because you added a method to contextShims.ts, that is the guard
//          working: declare it in
//          app/scripts/scriptTypings/objectContexts.template.d.ts and run
//          `npm run gen:script-typings`.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { generateObjectContexts } from "../../../scripts/scriptTypings/generateObjectContexts";
import { probeSurface, OBJECT_TYPE_INTERFACES } from "../../../scripts/scriptTypings/probeShim";
import { ALLOWLIST } from "@api/scriptHost/allowlist";

const TEMPLATE_PATH = path.resolve(__dirname, "../../../scripts/scriptTypings/objectContexts.template.d.ts");
const GENERATED_PATH = path.resolve(__dirname, "../objectContexts.d.ts");
const POLICY_PATH = path.resolve(__dirname, "../../../src/api/scriptHost/generated/scriptSurfacePolicy.ts");
const SLICE_PATH = path.resolve(__dirname, "../../../src/api/scriptHost/generated/scriptSurfaceSlices.ts");

function readTemplate(): string {
  return fs.readFileSync(TEMPLATE_PATH, "utf8");
}

describe("objectContexts.d.ts is generated, not maintained", () => {
  it("declares every member the worker shim actually exposes, and nothing it does not", () => {
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(
      result.problems,
      "the object-script typings and the worker context shim disagree:\n  - " +
        result.problems.join("\n  - ") +
        "\n\nFix app/scripts/scriptTypings/objectContexts.template.d.ts, then run `npm run gen:script-typings`.",
    ).toEqual([]);
  });

  it("matches the committed objectContexts.d.ts byte for byte", () => {
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.problems).toEqual([]);
    const committed = fs.readFileSync(GENERATED_PATH, "utf8");
    expect(
      committed === result.output,
      "extensions/ScriptableObjects/objectContexts.d.ts is stale — run `npm run gen:script-typings`.",
    ).toBe(true);
  });

  it("matches the committed scriptSurfacePolicy.ts byte for byte", () => {
    // The SECOND artifact of the same pass: the surface as DATA, which the draft
    // validator (api/scriptHost/scriptValidation) indexes to answer "is this a
    // real method?" and "what capability does calling it need?". It is checked
    // here rather than in its own file because both outputs come from ONE probe
    // — a test that let them drift apart would be checking nothing worth
    // checking. Design: docs/design/local-model-script-authoring.md §5a.
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.problems).toEqual([]);
    const committed = fs.readFileSync(POLICY_PATH, "utf8");
    expect(
      committed === result.policyOutput,
      "src/api/scriptHost/generated/scriptSurfacePolicy.ts is stale — run `npm run gen:script-typings`.",
    ).toBe(true);
  });

  it("matches the committed scriptSurfaceSlices.ts byte for byte", () => {
    // The THIRD artifact of the same pass: signature-only, per object type,
    // priced in tokens, for injecting into a script-authoring prompt. Same
    // reasoning as the policy map above — one probe, so they cannot disagree.
    // Design: docs/design/local-model-script-authoring.md §6.
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.problems).toEqual([]);
    const committed = fs.readFileSync(SLICE_PATH, "utf8");
    expect(
      committed === result.sliceOutput,
      "src/api/scriptHost/generated/scriptSurfaceSlices.ts is stale — run `npm run gen:script-typings`.",
    ).toBe(true);
  });

  it("keeps the prompt slices free of the prose that made the .d.ts unusable", () => {
    // The whole reason the slices exist: objectContexts.d.ts is ~96,800 estimated
    // tokens and roughly 85% of that is prose, worked examples and the generated
    // policy paragraphs. If any of it leaks back in, the slices stop fitting a
    // context window and M4 has silently undone itself.
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.sliceOutput).not.toContain("Calcula policy (generated)");
    expect(result.sliceOutput).not.toContain("```");
    // No JSDoc block may survive inside a signature. A member whose type is a
    // nested type literal carries that literal's own comments, which is how
    // `api.text` dragged 200+ characters of CSV prose into what was meant to be
    // a declaration. Asserted on `/**` rather than on newlines, because a
    // signature legitimately CAN contain the characters backslash-n: `toCsv`
    // takes `lineEnding?: "\r\n" | "\n" | "\r"`, and an earlier version of this
    // test read those string-literal types as multi-line signatures.
    const sigs = [...result.sliceOutput.matchAll(/signature: "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(sigs.length).toBeGreaterThan(700);
    expect(sigs.filter((s) => s.includes("/**"))).toEqual([]);
    // And the whole thing must stay far under the .d.ts it came from.
    //
    // The bar was `/ 2` while the slices were keyed by CHAIN. Keying them by
    // DECLARATION added 51 rows and an `ifaces` list per row, and withholding
    // the unreachable subtrees shrank SHARED_CHAINS from 526 to 424: measured
    // 209,483 chars against the .d.ts's 347,527, a ratio of 0.603. `* 0.65`
    // (225,892) keeps ~16 KB of headroom and still catches a prose leak, which
    // is the only thing this assertion was ever for.
    //
    // The PROMPT did not grow with the file. Every object type's resolved pool
    // is the same size or smaller than before (button 528 -> 426, sheet and
    // table unchanged at 543/554), because the rows that vanished from a type's
    // slice are the ones it could never call. Worst-case full surface after:
    // 24,384 tokens against the assembler's 40,000 ceiling.
    expect(result.sliceOutput.length).toBeLessThan(
      fs.readFileSync(GENERATED_PATH, "utf8").length * 0.65,
    );
  });

  it("keeps one slice entry per DISTINCT DECLARATION, covering every declaration site", () => {
    // A CHAIN IS NOT UNIQUE. `getCellValue` is declared three times with three
    // signatures and two different brokers: ShapeContext takes an A1 string,
    // TableContext a data row plus a column index, SheetContext row + col +
    // optional sheet. Keyed by chain, the slices kept whichever interface sorted
    // first and told every sheet script the SHAPE signature — the only
    // description of the API a model is shown, so the draft came back calling a
    // method that does not exist on its context, passed the whole validator
    // ladder (the reach check matches by CHAIN and cannot see arity) and did
    // nothing at run time.
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.problems).toEqual([]);

    const entries = [
      ...result.sliceOutput.matchAll(
        /^ {2}\{ chain: ("(?:[^"\\]|\\.)*"), ifaces: (\[[^\]]*\]), signature: ("(?:[^"\\]|\\.)*")/gm,
      ),
    ].map((m) => ({
      chain: JSON.parse(m[1]) as string,
      ifaces: JSON.parse(m[2]) as string[],
      signature: JSON.parse(m[3]) as string,
    }));

    // One row per DECLARATION sits strictly between one row per chain (which
    // throws declarations away) and one row per (chain, iface) pair (which
    // repeats an inherited declaration 176 times for no gain).
    const chains = new Set(entries.map((e) => e.chain));
    expect(chains.size).toBe(667);
    expect(entries.length).toBe(718);
    expect(entries.length).toBeGreaterThan(chains.size);

    const policyPairs = new Set(
      [
        ...result.policyOutput.matchAll(
          /^ {2}\{ chain: ("(?:[^"\\]|\\.)*"), iface: ("(?:[^"\\]|\\.)*")/gm,
        ),
      ].map((m) => `${JSON.parse(m[1])}|${JSON.parse(m[2])}`),
    );
    expect(policyPairs.size).toBe(894);
    expect(entries.length).toBeLessThan(policyPairs.size);

    // TOTALITY, which is what makes `entryFor`'s exact match total: every
    // (chain, iface) pair the policy knows appears in exactly ONE entry.
    const slicePairs: string[] = [];
    for (const e of entries) for (const iface of e.ifaces) slicePairs.push(`${e.chain}|${iface}`);
    const seen = new Set<string>();
    const duplicated = slicePairs.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
    expect(duplicated, "a (chain, iface) pair is declared by two slice entries").toEqual([]);
    const missing = [...policyPairs].filter((p) => !seen.has(p)).sort();
    expect(
      missing.length,
      `${missing.length} (chain, iface) pair(s) the policy knows have no slice entry, ` +
        `so a script on that object type is shown another interface's declaration: ${missing.slice(0, 5).join(", ")}`,
    ).toBe(0);
    const extra = [...seen].filter((p) => !policyPairs.has(p)).sort();
    expect(extra, "slice entries claim interfaces the policy has no row for").toEqual([]);

    // The concrete member the chain-keyed artifact lied about. Three distinct
    // signatures, so no ordering of the interfaces can make one of them right
    // for all three. (Do NOT extend this to a (chain, signature) uniqueness
    // claim over the whole file: 14 chains legitimately share a signature
    // across 26 rows.)
    const getCellValue = entries.filter((e) => e.chain === "getCellValue");
    expect(getCellValue.flatMap((e) => e.ifaces).sort()).toEqual([
      "ShapeContext",
      "SheetContext",
      "TableContext",
    ]);
    expect(new Set(getCellValue.map((e) => e.signature)).size).toBe(3);

    // The two artifacts must agree on which interface each object type is
    // handed, because `entryFor` resolves a chain THROUGH that table.
    const rootIfaces = Object.fromEntries(
      [
        ...result.sliceOutput.matchAll(
          /^ {2}("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),$/gm,
        ),
      ].map((m) => [JSON.parse(m[1]) as string, JSON.parse(m[2]) as string]),
    );
    const policyContexts = Object.fromEntries(
      [
        ...result.policyOutput.matchAll(
          /^ {2}\[("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\],$/gm,
        ),
      ].map((m) => [JSON.parse(m[1]) as string, JSON.parse(m[2]) as string]),
    );
    expect(Object.keys(rootIfaces).length).toBe(OBJECT_TYPE_INTERFACES.length);
    expect(rootIfaces).toEqual(policyContexts);
  });

  it("publishes a chain as SHARED only when every context can reach it", () => {
    // "Shared" used to mean "the declaring interface is BaseObjectContext or a
    // named subtree", which answers a different question. A named subtree is
    // reachable only through the member that HANDS IT OUT, and `range()` /
    // `cell()` are declared on SheetContext and TableContext alone — so all 51
    // `range.*` and all 51 `cell.*` chains were published to all 17 object
    // types while the `range` / `cell` entry points were correctly withheld. At
    // the chat's own 6,000-token budget that put 22 uncallable members in a
    // button prompt, under a header saying "these are the ONLY methods this
    // script may call".
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.problems).toEqual([]);

    const shared = JSON.parse(
      /export const SHARED_CHAINS: readonly string\[\] = (\[[^\n]*?\]);/.exec(result.sliceOutput)![1],
    ) as string[];
    const parseMap = (name: string): Record<string, string[]> => {
      const block = new RegExp(`export const ${name}[^{]*\\{\\n([\\s\\S]*?)\\n\\};`).exec(
        result.sliceOutput,
      )![1];
      const out: Record<string, string[]> = {};
      for (const line of block.split("\n")) {
        const m = /^ {2}("(?:[^"\\]|\\.)*"): (\[[^\]]*\]),$/.exec(line)!;
        out[JSON.parse(m[1]) as string] = JSON.parse(m[2]) as string[];
      }
      return out;
    };
    const own = parseMap("OWN_CHAINS_BY_OBJECT_TYPE");
    const reachable = parseMap("REACHABLE_CHAINS_BY_OBJECT_TYPE");

    // (a) NON-VACUITY FIRST. Every assertion below is over these sets, so an
    // empty one would make the rest pass while saying nothing.
    expect(shared.length).toBeGreaterThan(300);
    expect(Object.keys(own).length).toBe(OBJECT_TYPE_INTERFACES.length);
    expect(Object.keys(reachable).length).toBe(OBJECT_TYPE_INTERFACES.length);

    // (b) `isKnownObjectType` reads one map and `chainsForObjectType` the
    // other; a key in one and not the other is a type the ranker calls known
    // and then hands the shared surface only.
    expect(Object.keys(reachable).sort()).toEqual(Object.keys(own).sort());

    // (c) The members the old rule got wrong, named.
    expect(shared).not.toContain("cell.setValue");
    expect(shared).not.toContain("range.setValue");
    // ...while the SAME interface reached through a member every context has
    // stays shared, so this is narrowing and not a blanket exclusion.
    expect(shared).toContain("api.table.range.setValue");
    expect(reachable.sheet).toContain("range");
    expect(reachable.sheet).toContain("cell.setValue");
    expect(reachable.table).toContain("cell.setValue");
    for (const chain of ["range", "cell", "range.setValue", "cell.setValue"]) {
      expect(
        reachable.button,
        `a button script cannot obtain a ScriptRange, so ${chain} must not be offered to one`,
      ).not.toContain(chain);
    }

    // (d) CLOSURE, which is the general form of (c): a member is only callable
    // if the object it hangs off is itself callable. The probe emits six chains
    // whose entry point keeps its call parens (`getFields().columns`,
    // `getRange().start`), so a prefix counts as present either as written or
    // with a trailing "()" stripped.
    const violations: string[] = [];
    for (const objectType of Object.keys(reachable)) {
      const set = new Set([...shared, ...reachable[objectType]]);
      for (const chain of set) {
        if (!chain.includes(".")) continue;
        const prefix = chain.slice(0, chain.lastIndexOf("."));
        if (set.has(prefix) || set.has(prefix.replace(/\(\)$/, ""))) continue;
        violations.push(`${objectType}: ${chain} (needs ${prefix})`);
      }
    }
    expect(
      violations.length,
      `${violations.length} chain(s) are offered to an object type that cannot reach their ` +
        `entry point: ${violations.slice(0, 5).join(", ")}`,
    ).toBe(0);
  });

  it("gives the validator a surface with the capability-bearing members on it", () => {
    // A guard against the map silently emptying: an empty surface would make the
    // reach check pass everything and the capability check demand nothing, and
    // every validator test would still be green because they assert on findings.
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    const rows = [...result.policyOutput.matchAll(/\{ chain: "([^"]+)"[^\n]*?\},/g)].map((m) => m[1]);
    expect(rows.length, "the emitted surface is suspiciously small").toBeGreaterThan(300);
    // Every capability the allowlist gates must be reachable through some chain,
    // or a script could need one the validator can never derive.
    const gated = new Set(
      Object.values(ALLOWLIST).map((p) => p.capability).filter((c): c is string => Boolean(c)),
    );
    const emitted = new Set(
      [...result.policyOutput.matchAll(/capability: "([^"]+)"/g)].map((m) => m[1]),
    );
    // ONE exemption, and it is permanent rather than a gap to close.
    // `formula.udf` gates `formula.udf.invoke`, which is the HOST calling INTO a
    // script when a worksheet formula uses its UDF — the opposite direction from
    // everything else in the allowlist. No object-script context member requires
    // it, so no source scan can ever derive it, and a script that declares it
    // will always draw a `declared-not-observed` NOTICE. That is the correct
    // outcome (§11.2: a declaration we cannot observe is shown, never rejected),
    // which is why this is exempted here instead of the guard being weakened.
    const EXEMPT = new Set(["formula.udf"]);
    const unreachable = [...gated].filter((c) => !emitted.has(c) && !EXEMPT.has(c)).sort();
    // The exemption must not outlive its subject: if a chain ever DOES reach it,
    // this list is stale and should shrink.
    for (const c of EXEMPT) {
      expect(emitted.has(c), `${c} is now reachable from a chain — drop it from EXEMPT`).toBe(false);
    }
    expect(
      unreachable,
      "these capabilities are gated by the broker but no author-facing chain reaches them, " +
        "so the validator can never derive them from source: " + unreachable.join(", "),
    ).toEqual([]);
  });

  it("covers every objectType buildTyped can mount", () => {
    // The probe drives the objectType list; this pins that the list is the one
    // the shim's switch actually has, so a NEW objectType cannot ship with no
    // context interface at all.
    const shimSource = fs.readFileSync(
      path.resolve(__dirname, "../../../src/api/scriptHost/worker/contextShims.ts"),
      "utf8",
    );
    const cases = [...shimSource.matchAll(/^\s{4}case "([a-zA-Z]+)":/gm)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(10);
    const covered = new Set(OBJECT_TYPE_INTERFACES.map(([t]) => t));
    const missing = cases.filter((c) => !covered.has(c));
    expect(
      missing,
      `contextShims.ts buildTyped handles objectType(s) the typings generator does not probe: ${missing.join(", ")}. ` +
        "Add them to OBJECT_TYPE_INTERFACES in app/scripts/scriptTypings/probeShim.ts.",
    ).toEqual([]);
  });
});

describe("generated broker policy", () => {
  const probe = probeSurface();

  it("resolves every probed broker method against the allowlist", () => {
    // A shim method that dispatches to a broker name the allowlist does not
    // know is a call that can only ever be denied — and it would silently emit
    // no policy JSDoc, so IntelliSense would describe it as if it were free.
    const unknown = new Set<string>();
    for (const iface of probe.interfaces.values()) {
      for (const member of iface.members.values()) {
        if (member.broker && !ALLOWLIST[member.broker]) unknown.add(member.broker);
      }
    }
    expect([...unknown], "shim methods dispatch to broker methods with no allowlist policy").toEqual([]);
  });

  it("publishes the allowlist `desc` verbatim so the tooltip and the consent prompt agree", () => {
    const generated = fs.readFileSync(GENERATED_PATH, "utf8");
    // Every capability-gated method reachable from a script context must have
    // its consent sentence visible in the editor, not only in the prompt.
    const reachable = new Set<string>();
    for (const iface of probe.interfaces.values()) {
      for (const member of iface.members.values()) {
        if (member.broker) reachable.add(member.broker);
      }
    }
    const gated = [...reachable].filter((m) => ALLOWLIST[m]?.capability);
    expect(gated.length).toBeGreaterThan(20);
    const undocumented = gated.filter((m) => !generated.includes(ALLOWLIST[m].desc));
    expect(
      undocumented,
      "capability-gated methods whose consent text is missing from the typings: " + undocumented.join(", "),
    ).toEqual([]);
  });

  it("names the capability every gated method needs", () => {
    const generated = fs.readFileSync(GENERATED_PATH, "utf8");
    for (const capability of new Set(
      Object.values(ALLOWLIST)
        .map((p) => p.capability)
        .filter((c): c is NonNullable<typeof c> => !!c),
    )) {
      expect(generated, `capability ${capability} is never named in the typings`).toContain(capability);
    }
  });
});

describe("the surface the drift actually hid", () => {
  // Regression pins for the specific members that existed on the shim and were
  // missing from the typings when the generator was introduced. They are cheap,
  // and they document what "the typings drifted" concretely cost an author.
  const generated = fs.readFileSync(GENERATED_PATH, "utf8");

  it.each([
    ["biQuery", "structured BI model queries"],
    ["biSql", "raw SQL against a BI connection"],
    ["listBiConnections", "enumerating BI connections"],
    ["ScriptCubeApi", "the CUBE value/kpi/members surface"],
    ["ScriptConnectorApi", "registering a script data connector"],
    ["RangeContext", "cell-behavior bindings"],
    ["ChartMarkContext", "custom chart marks"],
  ])("declares %s (%s)", (symbol) => {
    expect(generated).toContain(symbol);
  });

  it("puts shape.declareProperties on the context, not under render", () => {
    // The typings used to declare `render.declareProperties`, which does not
    // exist; the real method is on the context itself.
    expect(generated).toMatch(/declareProperties\(props: DeclaredProperty\[\]\): void;/);
    const shapeIface = generated.slice(generated.indexOf("declare interface ShapeContext"));
    const renderBlock = shapeIface.slice(shapeIface.indexOf("render: {"), shapeIface.indexOf("\n}"));
    expect(renderBlock).not.toContain("declareProperties");
  });
});
