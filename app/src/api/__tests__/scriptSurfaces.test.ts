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
import {
  EXTENSION_BROKER_METHODS,
  CONTRIBUTION_REQUIRED_CAPABILITY,
  EXTENSION_PUSHED_DATA_CAPABILITIES,
} from "../scriptHost/extensionProtocol";
import {
  computeExtensionCeiling,
  unreachableExtensionCapabilities,
} from "../../shell/registries/extensionTrust";

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
      "script-library",
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
      // A third-party library imported with `// @uses`: its module bodies run in
      // their own hardened worker realm, so authored code really does execute.
      "script-library",
      // The publisher's writeback predicate: authoritatively evaluated in the
      // embedded Rust QuickJS realm at submit (and mounted advisory-only in a
      // worker realm), so authored code really does execute here.
      "writeback-validator",
    ]);
  });

  it("capability-bearing surfaces are worker-realm or a Rust-gated QuickJS surface", () => {
    // Worker-realm surfaces are broker-gated. TWO rust-quickjs surfaces also
    // carry capabilities, and their gates differ in a way that matters:
    //
    //  - notebook-cell : the user's own just-in-time consent, held in the
    //                    server-side CapabilityStore (notebook-analysis-workbench.md).
    //  - mcp-tool      : NO consent prompt exists. The grant is host-set
    //                    (MCP_SCRIPT_CAPABILITIES = ["bi.query"], installed for
    //                    the run's surface id and dropped when it ends) and the
    //                    gate in front of it is the AI access tier
    //                    (check_mcp_access) plus the model's own RLS.
    //
    // Listing mcp-tool here is a correction, not a widening: the reach was
    // always there (mcp/tools.rs has injected a HostModelProvider since the MCP
    // co-author work) and the taxonomy said "grid-only". A THIRD id appearing in
    // this list is a real security decision — a QuickJS surface with capabilities
    // and no broker in front of it — so it must be argued for here, not added.
    const RUST_GATED_CAPABILITY_SURFACES: ScriptSurfaceId[] = ["notebook-cell", "mcp-tool"];
    for (const s of SCRIPT_SURFACES) {
      if (s.capabilities.length > 0) {
        const rustGated =
          s.runtime === "rust-quickjs" && RUST_GATED_CAPABILITY_SURFACES.includes(s.id);
        expect(
          s.runtime === "worker-realm" || rustGated,
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
    // The one-off QuickJS surface gets NO model provider at all — its entry
    // point (ScriptEngine::run_with_options) has no provider parameter — so it
    // stays capability-free.
    expect(getScriptSurface("one-off-script")?.capabilities).toEqual([]);
    // MCP is NOT in that company, and saying it was is the defect this pin now
    // guards against. `mcp/tools.rs run_script_with_model` injects a
    // HostModelProvider for execute_script and grants exactly
    // MCP_SCRIPT_CAPABILITIES = ["bi.query"] — no bi.sql, so `model.sql` throws
    // there. Widening this list means an AI client can reach further into the
    // user's BI model with no consent prompt in the way (this surface has none),
    // so it is a deliberate security decision, never a drive-by.
    expect(getScriptSurface("mcp-tool")?.capabilities).toEqual(["bi.query"]);
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
 *  manifest / library definition) AND whose broker door is the whole shared
 *  ALLOWLIST — nothing narrows them, so their row must list the whole
 *  broker-gated vocabulary, exactly. */
const AUTHOR_DECLARED_SURFACES: ScriptSurfaceId[] = [
  "object-script",
  // A library's ceiling is its own source pragmas, INTERSECTED at link time with
  // the importing script's. The row therefore has to state the un-intersected
  // author-declared set — what a GIVEN realm ends up holding is per-mount data
  // the code inventory reports, not a property of the surface.
  "script-library",
  "formula-udf",
  "chart-transform-sandbox",
];

/** Author-declared too — the signed sidecar's `capabilities` IS the declaration
 *  — but NARROWED by a second gate the others do not have: handleBrokerCall
 *  refuses anything outside EXTENSION_BROKER_METHODS before the broker sees it.
 *  So its row is legitimately SHORTER than the broker-gated vocabulary, and the
 *  adversarial pass found three ids (ui.html, bi.connector, ui.shortcut) that
 *  had been listed here anyway — reach the consent prompt named and the broker
 *  refused. Kept separate rather than folded in, so "shorter" has to stay a
 *  derived fact rather than becoming an excuse. */
const METHOD_NARROWED_SURFACES: ScriptSurfaceId[] = ["extension-worker"];

describe("script-surface capability completeness", () => {
  it("derives the broker-gated set from the ALLOWLIST itself", () => {
    const derived = brokerGatedCapabilities();
    const fromPolicies = new Set<CapabilityId>();
    for (const policy of Object.values(ALLOWLIST)) {
      if (policy.capability) fromPolicies.add(policy.capability);
    }
    expect(new Set(derived)).toEqual(fromPolicies);
    // bi.sql via cap.biSql — the row that used to go missing on object scripts.
    expect(derived).toContain("bi.sql");
  });

  it("every capability in the vocabulary is enforced SOMEWHERE, by a named gate", () => {
    // This replaces a stricter assertion that no longer describes the design:
    // "brokerGatedCapabilities() === ALL_CAPABILITY_IDS", i.e. every capability
    // is a broker method's capability. That held only while every capability
    // gated a CALL. `grid.read` does not: nothing calls anything: the HOST
    // pushes cell contents into a sandboxed add-in (a cellStyle contributor's
    // batch, a cell-change event payload) and the capability decides whether
    // the contents go in. There is no method to hang it on, and inventing a
    // `cap.gridRead` row that nothing dispatches would have been a lie told to
    // a test.
    //
    // What must still be true — and what this pins — is that no capability id
    // can exist without an enforcement site. An id in the vocabulary that no
    // gate consults would be pure consent theatre: it would appear in the
    // prompt, be granted, be shown in the transparency panel, and mean nothing.
    const brokerGated = new Set(brokerGatedCapabilities());
    const contributionGated = new Set(
      Object.values(CONTRIBUTION_REQUIRED_CAPABILITY).filter(Boolean) as CapabilityId[],
    );
    const hostPushGated = new Set<CapabilityId>(EXTENSION_PUSHED_DATA_CAPABILITIES);
    const unenforced = [...ALL_CAPABILITY_IDS].filter(
      (id) => !brokerGated.has(id) && !contributionGated.has(id) && !hostPushGated.has(id),
    );
    expect(
      unenforced,
      "these capability ids are in the vocabulary but no gate reads them — consent theatre",
    ).toEqual([]);

    // And the specific shape of grid.read, pinned so a future refactor cannot
    // quietly turn it back into an ungated disclosure:
    expect(brokerGated.has("grid.read"), "grid.read gates no CALL, by design").toBe(false);
    expect(contributionGated.has("grid.read"), "cellStyle must require it").toBe(true);
    expect(hostPushGated.has("grid.read"), "the event forwarder must require it").toBe(true);
    expect(CONTRIBUTION_REQUIRED_CAPABILITY.cellStyle).toBe("grid.read");
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

  it("the sandboxed-extension row lists EXACTLY what a sandboxed extension can reach", () => {
    // Derived from the THREE things that can require a capability on this
    // surface: a method it may call, a contribution kind it may register, and a
    // host-push path where the host sends workbook data INTO the sandbox.
    // Reconstructed here from the enforcing constants rather than imported, so a
    // change to extensionReachableCapabilities that silently widened the set
    // would still have to be reflected in BOTH places.
    const reachable = new Set<CapabilityId>();
    for (const method of EXTENSION_BROKER_METHODS) {
      const cap = ALLOWLIST[method]?.capability;
      if (cap) reachable.add(cap);
    }
    for (const cap of Object.values(CONTRIBUTION_REQUIRED_CAPABILITY)) {
      if (cap) reachable.add(cap);
    }
    for (const cap of EXTENSION_PUSHED_DATA_CAPABILITIES) {
      reachable.add(cap);
    }

    for (const id of METHOD_NARROWED_SURFACES) {
      const surface = getScriptSurface(id)!;
      expect(surface.runtime, id).toBe("worker-realm");
      expect(surface.mountCeiling, `${id} must NOT pin a mount ceiling`).toBeUndefined();
      expect(new Set(enforceableCapabilities(surface)), id).toEqual(reachable);
      expect(new Set(surface.capabilities), id).toEqual(reachable);
    }

    // The three the adversarial pass removed, pinned by name so a future edit
    // that re-adds one has to argue with this test rather than with a comment.
    const extensionRow = getScriptSurface("extension-worker")!;
    for (const absent of ["ui.html", "bi.connector", "ui.shortcut"] as CapabilityId[]) {
      expect(reachable.has(absent), `${absent} must have no door on this surface`).toBe(false);
      expect(extensionRow.capabilities, `${absent} must not be listed`).not.toContain(absent);
    }
    // ...and formula.udf must STAY, even though no broker method requires it:
    // admitContribution does, and deriving from methods alone would silently
    // strip every worksheet function an add-in ships.
    expect(extensionRow.capabilities).toContain("formula.udf");
    expect(
      [...EXTENSION_BROKER_METHODS].some((m) => ALLOWLIST[m]?.capability === "formula.udf"),
      "if a broker method ever requires formula.udf, this test's premise changed",
    ).toBe(false);
  });

  it("a sandboxed extension's ceiling drops what it cannot use, and says so", () => {
    // The consent prompt is built from this list ("Capabilities it can use: …"),
    // so anything that survives here is a promise the broker has to keep.
    const declared = [
      "storage",
      "ui.html",
      "bi.connector",
      "ui.shortcut",
      "formula.udf",
    ] as CapabilityId[];
    expect(computeExtensionCeiling(declared, "distributed").sort()).toEqual([
      "formula.udf",
      "storage",
    ]);
    expect(unreachableExtensionCapabilities(declared, "distributed").sort()).toEqual([
      "bi.connector",
      "ui.html",
      "ui.shortcut",
    ]);
    // A built-in is not ceiling-bound, so neither list applies to it.
    expect(computeExtensionCeiling(declared, "trusted")).toEqual([]);
    expect(unreachableExtensionCapabilities(declared, "trusted")).toEqual([]);
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
      // Every author-declared worker surface now understates its reach. The
      // sandboxed-extension row does NOT, and that is correct rather than a
      // gap: the probe row is not in EXTENSION_BROKER_METHODS, so a sandboxed
      // extension genuinely cannot reach it — which is the whole reason that
      // surface is derived separately.
      expect(understated.map((a) => a.surfaceId).sort()).toEqual(
        [...AUTHOR_DECLARED_SURFACES].sort(),
      );
      expect(
        understated.map((a) => a.surfaceId),
        "a method a sandboxed extension cannot call must not count against its row",
      ).not.toContain("extension-worker");
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
