// Tests for the unified script-surface taxonomy (Wave 3 / C3). Keeps the
// in-app source of truth honest: every surface in the design doc is present,
// capabilities reference only the one vocabulary, and the executes-user-code
// split matches the documented taxonomy.
//
// The COMPLETENESS block is the important one. The original membership guard
// could only prove "the ids I mention exist", so a row that listed FEWER
// capabilities than the broker really grants (object scripts silently missing
// bi.sql; formula UDFs claiming only formula.udf) passed forever — drift in the
// safe-LOOKING direction that no test could see. These tests derive the truth
// from the enforcing code (ALLOWLIST + the broker's handle builder) and fail on
// any understatement, including one introduced by a future `cap.*` row.

import { describe, it, expect } from "vitest";
import {
  SCRIPT_SURFACES,
  getScriptSurface,
  executableScriptSurfaces,
  scriptSurfacesReferenceOnlyKnownCapabilities,
  scriptSurfaceCapabilitiesAreComplete,
  auditScriptSurfaceCapabilities,
  brokerGatedCapabilities,
  enforceableCapabilities,
  BROKER_AUTO_LOCAL_CAPABILITIES,
  type ScriptSurfaceId,
} from "../scriptSurfaces";
import { ALL_CAPABILITY_IDS, type CapabilityId } from "../scriptHost/capabilityIds";
import { ALLOWLIST, type MethodPolicy } from "../scriptHost/allowlist";
import { buildHandleFromDefinition } from "../scriptHost/broker";

describe("script-surface taxonomy", () => {
  it("covers exactly the documented surfaces", () => {
    const ids = SCRIPT_SURFACES.map((s) => s.id).sort();
    const expected: ScriptSurfaceId[] = [
      "chart-mark",
      "chart-transform",
      "chart-transform-sandbox",
      "extension-worker",
      "formula-udf",
      "mcp-tool",
      "notebook-cell",
      "object-script",
      "one-off-script",
      "writeback-validator",
    ];
    expect(ids).toEqual(expected);
  });

  it("references only capabilities from the single vocabulary", () => {
    expect(scriptSurfacesReferenceOnlyKnownCapabilities()).toBe(true);
  });

  it("classifies which surfaces execute imperative user code", () => {
    const exec = executableScriptSurfaces()
      .map((s) => s.id)
      .sort();
    // Worker-realm user code runs: object scripts, sandboxed EXTENSIONS, UDFs,
    // chart marks + transforms, notebooks, one-off scripts. MCP counts too — its
    // execute_script tool hands agent-authored JS to
    // script_engine::ScriptEngine::run (the same isolated QuickJS as one-off
    // scripts). Only the built-in chart-transform pipeline (pure declarative)
    // executes no authored code.
    expect(exec).toEqual([
      "chart-mark",
      "chart-transform-sandbox",
      "extension-worker",
      "formula-udf",
      "mcp-tool",
      "notebook-cell",
      "object-script",
      "one-off-script",
      // The publisher's writeback predicate: authoritatively evaluated in the
      // embedded Rust QuickJS realm at submit (and mounted advisory-only in a
      // worker realm), so authored code really does execute here.
      "writeback-validator",
    ]);
  });

  it("capability-bearing surfaces are worker-realm or the Rust-gated notebook", () => {
    for (const s of SCRIPT_SURFACES) {
      if (s.capabilities.length > 0) {
        // Worker-realm surfaces are broker-gated; the notebook (rust-quickjs)
        // is the ONE non-worker surface with capabilities — its gate is the
        // server-side CapabilityStore (see notebook-analysis-workbench.md).
        const rustGatedNotebook = s.id === "notebook-cell" && s.runtime === "rust-quickjs";
        expect(
          s.runtime === "worker-realm" || rustGatedNotebook,
          `unexpected capability-bearing surface: ${s.id} (${s.runtime})`,
        ).toBe(true);
      }
    }
  });

  it("the notebook carries EXACTLY the read-only model pair (anti-goal pin)", () => {
    // The analysis-workbench identity forbids net.fetch/storage/ui.html/
    // formula.udf on notebook cells — model reads only. A change here is a
    // deliberate security-design decision, not a drive-by. (HostModelProvider,
    // bi/script_provider.rs, checks exactly bi.query + bi.sql.)
    expect(getScriptSurface("notebook-cell")?.capabilities.slice().sort()).toEqual([
      "bi.query",
      "bi.sql",
    ]);
    // The one-off / MCP QuickJS surfaces get NO model provider at all
    // (script-engine/src/model_provider.rs), so they stay capability-free.
    expect(getScriptSurface("one-off-script")?.capabilities).toEqual([]);
    expect(getScriptSurface("mcp-tool")?.capabilities).toEqual([]);
  });

  it("getScriptSurface resolves by id", () => {
    expect(getScriptSurface("notebook-cell")?.runtime).toBe("rust-quickjs");
    expect(getScriptSurface("object-script")?.runtime).toBe("worker-realm");
    expect(getScriptSurface("nope" as ScriptSurfaceId)).toBeUndefined();
  });
});

// ============================================================================
// Completeness: the taxonomy vs. what the broker really enforces
// ============================================================================

/** Surfaces whose R19 ceiling comes from the AUTHOR (source pragmas / package
 *  manifest / library definition) — nothing narrows them, so their row must
 *  list the whole broker-gated vocabulary, exactly. */
const AUTHOR_DECLARED_SURFACES: ScriptSurfaceId[] = [
  "object-script",
  // The signed sidecar manifest's `capabilities` IS the author declaration.
  "extension-worker",
  "formula-udf",
  "chart-transform-sandbox",
];

describe("script-surface capability completeness", () => {
  it("derives the broker-gated set from the ALLOWLIST itself", () => {
    const derived = brokerGatedCapabilities();
    const fromPolicies = new Set<CapabilityId>();
    for (const policy of Object.values(ALLOWLIST)) {
      if (policy.capability) fromPolicies.add(policy.capability);
    }
    expect(new Set(derived)).toEqual(fromPolicies);
    // Today every capability in the vocabulary has at least one gated method,
    // so the derived set is the whole vocabulary (bi.sql via cap.biSql
    // included — the row that used to go missing on object scripts).
    expect(derived.slice().sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
    expect(derived).toContain("bi.sql");
  });

  it("no surface understates what the enforcing code can grant it", () => {
    const audit = auditScriptSurfaceCapabilities();
    const offenders = audit
      .filter((a) => a.understated.length > 0)
      .map((a) => `${a.surfaceId}: missing ${a.understated.join(", ")}`);
    expect(offenders, "taxonomy understates reach").toEqual([]);
    expect(scriptSurfaceCapabilitiesAreComplete()).toBe(true);
  });

  it("no surface overstates either (rows stay in lockstep, both directions)", () => {
    const stale = auditScriptSurfaceCapabilities()
      .filter((a) => a.overstated.length > 0)
      .map((a) => `${a.surfaceId}: stale ${a.overstated.join(", ")}`);
    expect(stale).toEqual([]);
  });

  it("author-declared worker surfaces list EXACTLY the broker-gated vocabulary", () => {
    const gated = brokerGatedCapabilities();
    for (const id of AUTHOR_DECLARED_SURFACES) {
      const surface = getScriptSurface(id)!;
      expect(surface.runtime, id).toBe("worker-realm");
      expect(surface.mountCeiling, `${id} must NOT pin a mount ceiling`).toBeUndefined();
      expect(enforceableCapabilities(surface), id).toEqual(gated);
      expect(surface.capabilities.slice().sort(), id).toEqual(gated.slice().sort());
    }
  });

  it("object scripts declare bi.sql (the confirmed drift, pinned)", () => {
    // cap.biSql is tier "restricted": ANY worker-realm script that declares
    // bi.sql and is granted it can run raw read-only SQL against a BI
    // connection's database. The taxonomy used to omit it entirely.
    expect(getScriptSurface("object-script")?.capabilities).toContain("bi.sql");
    expect(ALLOWLIST["cap.biSql"].capability).toBe("bi.sql");
    expect(ALLOWLIST["cap.biSql"].tier).toBe("restricted");
  });

  it("formula UDFs declare the library's whole reach, not just formula.udf", () => {
    // A UDF body runs inside the Custom Functions library mount, whose ceiling
    // is `lib.capabilities` (customFunctions.ts rawInstall) — unfiltered, so any
    // capability in the vocabulary. formula.udf only gates the INVOCATION.
    const udf = getScriptSurface("formula-udf")!;
    expect(udf.runtime).toBe("worker-realm");
    expect(udf.capabilities).toContain("formula.udf");
    expect(udf.capabilities).toContain("bi.query"); // cube.* in a UDF body
    expect(udf.capabilities).toContain("bi.sql");
    expect(udf.capabilities).toContain("net.fetch");
  });

  it("chart marks are pinned to their hard-coded mount ceiling", () => {
    const mark = getScriptSurface("chart-mark")!;
    // chartMarkScripts.ts rawInstall mounts every mark with declaredCapabilities: [].
    expect(mark.mountCeiling).toEqual([]);
    // ...but the broker auto-declares + auto-grants ui.html to LOCAL scripts,
    // so a local mark DOES hold it (inert: render.setHtml addresses a shape).
    expect(enforceableCapabilities(mark)).toEqual([...BROKER_AUTO_LOCAL_CAPABILITIES]);
    expect(mark.capabilities).toEqual([...BROKER_AUTO_LOCAL_CAPABILITIES]);
    expect(mark.capabilities).not.toContain("net.fetch");
    expect(mark.capabilities).not.toContain("bi.query");
    expect(mark.capabilities).not.toContain("bi.sql");
    expect(mark.capabilities).not.toContain("storage");
  });

  it("BROKER_AUTO_LOCAL_CAPABILITIES matches what the broker really adds", () => {
    // Derived from the enforcing code, not asserted: a mount that declares
    // NOTHING, with local provenance, still comes back with a non-empty ceiling
    // + grant set. If the broker's auto-grant changes, this fails and the
    // chart-mark row above must be re-derived.
    const local = buildHandleFromDefinition({
      id: "scriptSurfaces.test/auto-local-probe",
      name: "probe",
      objectType: "chartMark",
      instanceId: null,
      accessLevel: "restricted",
      declaredCapabilities: [],
    });
    expect([...local.declaredCapabilities].sort()).toEqual(
      [...BROKER_AUTO_LOCAL_CAPABILITIES].sort(),
    );
    for (const cap of BROKER_AUTO_LOCAL_CAPABILITIES) {
      expect(local.grants.has(cap), `local scripts are auto-granted ${cap}`).toBe(true);
    }

    // A DISTRIBUTED mount that declares nothing gets nothing — which is why the
    // chart-mark containment text says a distributed mark holds no capability.
    const distributed = buildHandleFromDefinition({
      id: "scriptSurfaces.test/auto-distributed-probe",
      name: "probe",
      objectType: "chartMark",
      instanceId: null,
      accessLevel: "restricted",
      provenance: "distributed",
      packageName: "pkg",
      declaredCapabilities: [],
    });
    expect([...distributed.declaredCapabilities]).toEqual([]);
  });

  it("a NEW cap.* row in the allowlist fails the guard until the taxonomy is updated", () => {
    // The whole point of a completeness guard: adding privileged reach to the
    // broker must break the build, not quietly widen what scripts can do while
    // the transparency panel keeps showing the old, smaller answer.
    const probe: MethodPolicy = {
      tier: "restricted",
      capability: "test.newReach" as CapabilityId,
      class: "net",
      validate: () => true,
      desc: "probe capability added by the taxonomy completeness test",
    };
    ALLOWLIST["cap.__taxonomyProbe"] = probe;
    try {
      expect(brokerGatedCapabilities()).toContain("test.newReach" as CapabilityId);
      expect(scriptSurfaceCapabilitiesAreComplete()).toBe(false);
      const understated = auditScriptSurfaceCapabilities().filter(
        (a) => a.understated.length > 0,
      );
      // Every author-declared worker surface now understates its reach.
      expect(understated.map((a) => a.surfaceId).sort()).toEqual(
        [...AUTHOR_DECLARED_SURFACES].sort(),
      );
      for (const a of understated) {
        expect(a.understated).toEqual(["test.newReach"]);
      }
      // The membership guard, by contrast, still sees nothing wrong — which is
      // exactly why it was never enough on its own.
      expect(scriptSurfacesReferenceOnlyKnownCapabilities()).toBe(true);
    } finally {
      delete ALLOWLIST["cap.__taxonomyProbe"];
    }
    expect(scriptSurfaceCapabilitiesAreComplete()).toBe(true);
  });

  it("a row that drops a capability is caught as an understatement", () => {
    // Simulate the ORIGINAL defect (object scripts without bi.sql) against the
    // derivation, proving the guard would have caught it at the time.
    const objectScript = getScriptSurface("object-script")!;
    const drifted = {
      ...objectScript,
      capabilities: objectScript.capabilities.filter((c) => c !== "bi.sql"),
    };
    const enforceable = enforceableCapabilities(drifted);
    const declared = new Set(drifted.capabilities);
    expect(enforceable.filter((c) => !declared.has(c))).toEqual(["bi.sql"]);
  });
});
