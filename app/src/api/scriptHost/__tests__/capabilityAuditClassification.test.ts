//! FILENAME: app/src/api/scriptHost/__tests__/capabilityAuditClassification.test.ts
// PURPOSE: The drift guard `SERVER_AUDITED_METHODS` never had. Every
//          capability-bearing ALLOWLIST row must be classified as either
//          SERVER-audited (its Rust gate calls record_capability_call, so the
//          broker must NOT also persist the result) or BROKER-audited (nothing
//          server-side records it, so the broker's write is the only one).
// CONTEXT: The original set was written in Wave A/B with eight entries and was
//          never extended. Waves C-I added five more Rust gates
//          (script_writeback, script_scheduler, script_distribution, the cube
//          UDFs, and the bi.model diagnostics/batch actions) and every call
//          through them wrote TWO audit rows for one call. The failure mode in
//          the other direction is worse and is what this guard really protects:
//          adding a `cap.*` row to this set with no gate behind it makes the
//          broker skip its write while nobody else makes one — a capability call
//          that is audited NOWHERE.
//
//          Deliberately a CLASSIFICATION test rather than an equality snapshot:
//          a new `cap.*` row fails here until somebody decides which side it is
//          on and writes the reason down.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";
import { capabilityAuditClassification } from "../broker";

const { serverAudited, brokerAudited } = capabilityAuditClassification();

/** Every ALLOWLIST row that carries a capability — i.e. every row whose outcome
 *  `persistCapabilityAudit` is asked about at all. */
const CAPABILITY_METHODS = Object.entries(ALLOWLIST)
  .filter(([, policy]) => policy.capability !== undefined)
  .map(([method]) => method)
  .sort();

describe("capability-call audit classification", () => {
  it("there are capability-bearing rows to classify (the scan works)", () => {
    expect(CAPABILITY_METHODS.length).toBeGreaterThan(40);
  });

  it("every capability-bearing method is classified EXACTLY once", () => {
    const unclassified = CAPABILITY_METHODS.filter(
      (m) => !serverAudited.has(m) && !brokerAudited.has(m),
    );
    expect(
      unclassified,
      `these ALLOWLIST rows carry a capability but appear in neither map in broker.ts. ` +
        `Decide: does a Rust gate call record_capability_call for this method? If YES add it ` +
        `to SERVER_AUDITED_METHODS with the gate's name (the broker then skips its own write, ` +
        `to avoid double-recording). If NO add it to BROKER_AUDITED_CAPABILITY_METHODS with ` +
        `the reason (the broker's write is then the ONLY record of the call).`,
    ).toEqual([]);

    const both = CAPABILITY_METHODS.filter((m) => serverAudited.has(m) && brokerAudited.has(m));
    expect(both, "a method cannot be in both maps").toEqual([]);
  });

  it("neither map names a method that is not a capability-bearing ALLOWLIST row", () => {
    const known = new Set(CAPABILITY_METHODS);
    const strays = [...serverAudited.keys(), ...brokerAudited.keys()]
      .filter((m) => !known.has(m))
      .sort();
    expect(
      strays,
      `classified methods that no longer exist in the ALLOWLIST (or that lost their ` +
        `\`capability\` field, which makes persistCapabilityAudit return early). Remove them.`,
    ).toEqual([]);
  });

  it("every classification carries a non-empty reason", () => {
    for (const [method, why] of [...serverAudited, ...brokerAudited]) {
      expect(why.length, `${method} has no stated reason`).toBeGreaterThan(3);
    }
  });

  // --------------------------------------------------------------------------
  // The gates named as SERVER-audited really do record, in Rust.
  // --------------------------------------------------------------------------
  //
  // Naming a gate is a claim about another language's source. Reading it here is
  // what makes "the broker may safely skip its write" checkable rather than
  // asserted — the same technique interpreterReachDrift.test.ts uses.

  const REPO = path.resolve(__dirname, "../../../../..");
  /** The Rust file each named gate lives in. */
  const GATE_SOURCES: Record<string, string> = {
    script_http_fetch: "app/src-tauri/src/net_commands.rs",
    bi_query: "app/src-tauri/src/bi/commands.rs",
    script_bi_sql: "app/src-tauri/src/bi/commands.rs",
    script_bi_model: "app/src-tauri/src/bi/model_editor.rs",
    bi_script_source: "app/src-tauri/src/bi/script_source.rs",
    script_writeback: "app/src-tauri/src/scripting/writeback_gateway.rs",
    script_distribution: "app/src-tauri/src/scripting/distribution_gateway.rs",
    script_scheduler: "app/src-tauri/src/scripting/scheduler.rs",
    cube_udf_value: "app/src-tauri/src/bi/cube.rs",
    cube_udf_kpi: "app/src-tauri/src/bi/cube.rs",
    cube_udf_members: "app/src-tauri/src/bi/cube.rs",
  };

  /**
   * Top-level arguments of every `record_capability_call(...)` in `code`.
   * Walks parens and strings so a nested `format!("a, b")` is one argument,
   * which a comma split gets wrong.
   */
  function recordCallArgs(code: string): string[][] {
    const calls: string[][] = [];
    const NAME = "record_capability_call";
    for (let at = code.indexOf(NAME); at >= 0; at = code.indexOf(NAME, at + 1)) {
      let i = code.indexOf("(", at + NAME.length);
      if (i < 0) break;
      let depth = 0;
      let inStr = false;
      let arg = "";
      const args: string[] = [];
      for (; i < code.length; i++) {
        const c = code[i];
        if (inStr) {
          arg += c;
          if (c === "\\") { arg += code[++i] ?? ""; continue; }
          if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; arg += c; continue; }
        if (c === "(" || c === "[" || c === "{") { depth++; if (depth > 1) arg += c; continue; }
        if (c === ")" || c === "]" || c === "}") {
          depth--;
          if (depth === 0) { args.push(arg.trim()); break; }
          arg += c;
          continue;
        }
        if (c === "," && depth === 1) { args.push(arg.trim()); arg = ""; continue; }
        arg += c;
      }
      if (args.length) calls.push(args.filter((a) => a.length > 0));
    }
    return calls;
  }

  it("every gate named in SERVER_AUDITED_METHODS is a file that calls record_capability_call", () => {
    // The gate name is the leading token of the reason string
    // ("script_bi_model (info)" -> "script_bi_model").
    const gates = [...new Set([...serverAudited.values()].map((v) => v.split(" ")[0]))].sort();
    for (const gate of gates) {
      const rel = GATE_SOURCES[gate];
      expect(
        rel,
        `SERVER_AUDITED_METHODS names the Rust gate "${gate}", which this guard does not know ` +
          `where to find. Add it to GATE_SOURCES in this file so the claim "Rust records this ` +
          `call" can actually be checked — an unverifiable claim here silences the broker's ` +
          `own audit write.`,
      ).toBeDefined();
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      const code = src
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      expect(
        /record_capability_call\s*\(/.test(code),
        `${rel} (the gate behind "${gate}") does not call record_capability_call. The broker ` +
          `SKIPS its own audit write for methods classified server-audited, so these calls ` +
          `would be recorded NOWHERE.`,
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // The specific rows the stale set was missing.
  // --------------------------------------------------------------------------

  it("the Wave C-I gates are classified server-audited (the rows the old set missed)", () => {
    const shouldBeServerAudited = [
      "cap.writebackListRegions",
      "cap.writebackGetLayer",
      "cap.writebackSaveDraft",
      "cap.writebackSubmit",
      "cap.writebackPreview",
      "cap.writebackListSubmissions",
      "cap.writebackReview",
      "cap.scheduleEvery",
      "cap.scheduleAt",
      "cap.scheduleCancel",
      "cap.pkgListRegistries",
      "cap.pkgListSubscriptions",
      "cap.pkgBrowse",
      "cap.pkgInspect",
      "cap.pkgPull",
      "cap.pkgRefreshPreview",
      "cap.pkgRefreshApply",
      "cap.pkgPublishPreview",
      "cap.pkgNextVersion",
      "cap.pkgPublish",
      "cap.pkgPublishModel",
      "cap.cubeValue",
      "cap.cubeKpi",
      "cap.cubeMembers",
      "cap.biModelValidate",
      "cap.biModelLineage",
      "cap.biModelBatch",
    ];
    const missing = shouldBeServerAudited.filter((m) => !serverAudited.has(m));
    expect(
      missing,
      `these reach a Rust gate that records the call itself, so the broker must not ` +
        `double-record them`,
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // The gates record the OUTCOME, not just their own permission check.
  // --------------------------------------------------------------------------
  //
  // "The file calls record_capability_call" was satisfied by the
  // permission-denied branch alone, which every gate has — so a gate could
  // record a call the MODEL refused (object-level security, a row filter that
  // cannot be enforced) as a success, and the guard stayed green. A false
  // audit row is worse than a missing one: it tells a reviewer of the trail
  // that a refused query went through.
  //
  // The discriminator is the `error` argument. A permission-denied branch
  // passes a FIXED string ("bi.query not granted"); recording the outcome of
  // the call means passing the error VALUE, so the argument is a binding.

  it("every gate records a REFUSED call, not only its own permission denial", () => {
    const gates = [...new Set([...serverAudited.values()].map((v) => v.split(" ")[0]))].sort();
    for (const gate of gates) {
      const rel = GATE_SOURCES[gate];
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      const code = src
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      // ok=false (4th arg) AND a reason (6th) that is a runtime value.
      const recordsOutcome = recordCallArgs(code).some(
        (args) =>
          args.length >= 6 &&
          args[3] === "false" &&
          args[5].startsWith("Some(") &&
          !/^Some\(\s*"/.test(args[5]),
      );
      expect(
        recordsOutcome,
        `${rel} (the gate behind "${gate}") records only its own permission-denied branch, ` +
          `whose reason is a fixed string. Nothing there records a call that was ATTEMPTED and ` +
          `then refused — by object-level security, an unenforceable row filter, or the source. ` +
          `Because this method is classified server-audited the broker writes nothing, so such ` +
          `a call is either recorded as a SUCCESS or not at all. Add the failure arm: pass the ` +
          `error value as the reason.`,
      ).toBe(true);
    }
  });

  it("the outcome-recording guard is not vacuous (a permission-only gate fails it)", () => {
    // The shape the guard must REJECT: a fixed-string reason, which is what
    // every gate had before the failure arms were added.
    const permissionOnly = `
      fn gate() {
        record_capability_call(&s.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"));
        record_capability_call(&s.audit_log, "bi.query", sid, true, Some(&format!("x {}", y)), None);
      }`;
    const rejected = recordCallArgs(permissionOnly).some(
      (args) =>
        args.length >= 6 &&
        args[3] === "false" &&
        args[5].startsWith("Some(") &&
        !/^Some\(\s*"/.test(args[5]),
    );
    expect(rejected, "the guard would pass a gate that records no real failure").toBe(false);

    // And the shape it must ACCEPT, including a comma inside format!.
    const withFailureArm = `
      fn gate() {
        record_capability_call(&s.audit_log, "bi.query", sid, false, Some(&format!("conn {}, q", c)), Some(&e));
      }`;
    const accepted = recordCallArgs(withFailureArm).some(
      (args) =>
        args.length >= 6 &&
        args[3] === "false" &&
        args[5].startsWith("Some(") &&
        !/^Some\(\s*"/.test(args[5]),
    );
    expect(accepted, "the guard would reject a gate that does record a real failure").toBe(true);
  });

  it("cap.scheduleList stays BROKER-audited — its Rust arm records nothing", () => {
    // script_scheduler's "list" branch has no record_capability_call, so
    // classifying it server-audited would lose the row entirely.
    expect(serverAudited.has("cap.scheduleList")).toBe(false);
    expect(brokerAudited.has("cap.scheduleList")).toBe(true);
  });

  it("cap.biListConnections stays BROKER-audited — bi_get_connections takes no scriptId", () => {
    expect(serverAudited.has("cap.biListConnections")).toBe(false);
    expect(brokerAudited.has("cap.biListConnections")).toBe(true);
  });
});
