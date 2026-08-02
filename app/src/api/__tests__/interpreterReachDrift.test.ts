//! FILENAME: app/src/api/__tests__/interpreterReachDrift.test.ts
// PURPOSE: Close the last ASSERTED link in the transparency chain, and keep it
//          closed. The "Code in This File" panel tells the user a notebook /
//          one-off script / MCP script / writeback validator is "grid-only".
//          That claim used to rest on a hand-written comment. It now rests on
//          core/script-engine/src/manifest.rs, whose own Rust test diffs it
//          against the LIVE registered interpreter surface — and this file
//          diffs that manifest against every TypeScript consumer of the claim.
// CONTEXT: Same shape (and same reason) as the `include_str!` guard that pins
//          KNOWN_CAPABILITY_IDS in core/persistence/src/lib.rs against
//          capabilityIds.ts: read the OTHER language's source of truth at test
//          time instead of re-typing it, so the two cannot drift in silence.
//          This program shipped that exact silent drift three times
//          (`ui.dialog`, `distribution.writeback`, `schedule` were all stripped
//          by a Rust parser whose list had fallen behind), which is why the
//          rule here is: derive, never restate.
//
//          WHY THE RUST SIDE IS THE SOURCE OF TRUTH: the renderer can be
//          compromised, and the interpreter is where the sandbox actually is.
//          A TS constant claiming "no BI reach" means nothing if the QuickJS
//          realm has a working `model.query`. So the direction of the diff is
//          fixed: Rust states what the realm registers and how each host
//          surface builds it; TypeScript must match, never the reverse.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  QUICKJS_SURFACE_REACH,
  QUICKJS_SURFACE_CAPABILITIES,
  describeInterpreterReach,
  type InterpreterReachClass,
  type QuickJsSurfaceId,
} from "../codeInventory";
import { SCRIPT_SURFACES, type ScriptSurfaceId } from "../scriptSurfaces";
import { ALL_CAPABILITY_IDS, type CapabilityId } from "../scriptHost/capabilityIds";

const REPO = path.resolve(__dirname, "../../../..");
const MANIFEST_RS = path.join(REPO, "core/script-engine/src/manifest.rs");
const CALP_COMMANDS_RS = path.join(REPO, "app/src-tauri/src/calp_commands.rs");

const manifestSrc = fs.readFileSync(MANIFEST_RS, "utf8");

/** Where to send the reader when a diff fails. Repeated in every message on
 *  purpose: a guard whose failure does not name the fix is half a guard. */
const FIX =
  "FIX: core/script-engine/src/manifest.rs is the source of truth (its own Rust test " +
  "diffs it against the live QuickJS surface). Update the mirror in " +
  "app/src/api/codeInventory.ts (QUICKJS_SURFACE_REACH / QUICKJS_SURFACE_CAPABILITIES) " +
  "and the rust-quickjs rows of app/src/api/scriptSurfaces.ts to match it — never the " +
  "other way round.";

// ---------------------------------------------------------------------------
// Parse the Rust manifest
// ---------------------------------------------------------------------------

/** The slice between `<name> ... = &[` and the matching `];`. */
function rustSliceBody(name: string): string {
  const start = manifestSrc.indexOf(name);
  expect(start, `${name} not found in manifest.rs`).toBeGreaterThan(-1);
  const open = manifestSrc.indexOf("&[", start);
  expect(open, `no &[ after ${name}`).toBeGreaterThan(-1);
  const close = manifestSrc.indexOf("\n];", open);
  expect(close, `unterminated ${name}`).toBeGreaterThan(-1);
  return manifestSrc.slice(open + 2, close);
}

/** ReachClass variant -> wire string, IN ENUM ORDER (as_str's match arms are
 *  written in variant order, and that order is what `surface_reach()` sorts by,
 *  so the mirror's array order is checked too, not just its membership). */
function reachWireNames(): Map<string, InterpreterReachClass> {
  const map = new Map<string, InterpreterReachClass>();
  for (const m of manifestSrc.matchAll(/ReachClass::(\w+)\s*=>\s*"([^"]+)"/g)) {
    map.set(m[1], m[2] as InterpreterReachClass);
  }
  expect(map.size, "no ReachClass::X => \"y\" arms found in manifest.rs").toBeGreaterThan(0);
  return map;
}

interface RustOp {
  path: string;
  variant: string;
  reach: InterpreterReachClass;
  capability: CapabilityId | null;
}

function rustOps(): RustOp[] {
  const body = rustSliceBody("pub const OP_MANIFEST");
  const wire = reachWireNames();
  const ops: RustOp[] = [];
  const re = /\b(op|gated)\(\s*"([^"]+)"\s*,\s*ReachClass::(\w+)\s*(?:,\s*"([^"]+)"\s*)?\)/g;
  for (const m of body.matchAll(re)) {
    const [, kind, opPath, variant, capability] = m;
    const reach = wire.get(variant);
    expect(reach, `ReachClass::${variant} has no as_str() arm in manifest.rs`).toBeDefined();
    ops.push({
      path: opPath,
      variant,
      reach: reach as InterpreterReachClass,
      capability: kind === "gated" ? ((capability as CapabilityId) ?? null) : null,
    });
  }
  expect(ops.length, "OP_MANIFEST parsed as empty — the parser has drifted from the Rust syntax").toBeGreaterThan(50);
  return ops;
}

interface RustSurfaceProfile {
  id: string;
  modelProvider: boolean;
  /** The capability ids the host can hold FOR THIS SURFACE. Injecting a provider
   *  is necessary but not sufficient — `bi/script_provider.rs` re-checks the
   *  capability store per call — so a gated op is reachable only when its
   *  capability is in here too. `mcp-tool` is why this exists: provider + a
   *  `bi.query`-only grant, which makes `model.sql` unreachable there. */
  granted: string[];
  hostGlobalsDeleted: boolean;
  entryPoint: string;
}

function rustSurfaceProfiles(): RustSurfaceProfile[] {
  const body = rustSliceBody("pub const SURFACE_PROFILES");
  const profiles: RustSurfaceProfile[] = [];
  // Comments sit BETWEEN the fields in this struct (the mcp-tool row carries a
  // long one), so every gap is `[\s\S]*?` rather than `\s*`. `granted` is
  // REQUIRED: a profile without it cannot be derived, and silently defaulting it
  // to "everything the provider allows" is precisely the overstatement that
  // would hide a narrowed host grant.
  const re =
    /id:\s*"([^"]+)"\s*,[\s\S]*?model_provider:\s*(true|false)\s*,[\s\S]*?granted:\s*&\[([^\]]*)\]\s*,[\s\S]*?host_globals_deleted:\s*(true|false)\s*,[\s\S]*?entry_point:\s*"([^"]*)"/g;
  for (const m of body.matchAll(re)) {
    profiles.push({
      id: m[1],
      modelProvider: m[2] === "true",
      granted: [...m[3].matchAll(/"([^"]+)"/g)].map((g) => g[1]),
      hostGlobalsDeleted: m[4] === "true",
      entryPoint: m[5],
    });
  }
  expect(
    profiles.length,
    "SURFACE_PROFILES parsed as empty — either the struct gained/renamed a field " +
      "(this parser requires id, model_provider, granted, host_globals_deleted, entry_point " +
      "in that order) or the manifest moved.",
  ).toBeGreaterThan(0);
  return profiles;
}

/** The TS re-derivation of Rust's `surface_ops()`. Deliberately a re-derivation
 *  rather than a second constant: if the two implementations of the rule ever
 *  disagree, that is itself the drift we want to see.
 *
 *  BOTH halves of the call site's decision are applied, exactly as Rust applies
 *  them: the provider must be injected AND the op's capability must be one the
 *  host can hold on this surface. Checking only the provider (which this
 *  re-derivation used to do, because `granted` did not exist) would advertise
 *  `model.sql` on `mcp-tool`. */
function derivedOps(profile: RustSurfaceProfile, ops: RustOp[]): RustOp[] {
  if (profile.hostGlobalsDeleted) return [];
  return ops.filter(
    (o) =>
      o.capability === null ||
      (profile.modelProvider && profile.granted.includes(o.capability)),
  );
}

function derivedReach(profile: RustSurfaceProfile, ops: RustOp[]): InterpreterReachClass[] {
  const order = [...reachWireNames().values()];
  const present = new Set(derivedOps(profile, ops).map((o) => o.reach));
  return order.filter((r) => present.has(r));
}

function derivedCapabilities(profile: RustSurfaceProfile, ops: RustOp[]): CapabilityId[] {
  return [
    ...new Set(derivedOps(profile, ops).flatMap((o) => (o.capability ? [o.capability] : []))),
  ].sort();
}

const OPS = rustOps();
const PROFILES = rustSurfaceProfiles();

// ---------------------------------------------------------------------------
// (A) The reach claim is derived from the interpreter
// ---------------------------------------------------------------------------

describe("interpreter reach — codeInventory mirrors the Rust op manifest", () => {
  it("the ReachClass wire vocabulary is identical in both languages", () => {
    const rust = [...reachWireNames().values()].sort();
    // Derived from the mirror itself rather than re-typed: every class the
    // mirror uses anywhere, plus the ones only the labels know about.
    const tsUsed = new Set<string>(
      Object.values(QUICKJS_SURFACE_REACH).flatMap((r) => [...r]),
    );
    // Every Rust class must be expressible in TS...
    const notInTs = rust.filter((r) => !tsUsed.has(r) && r !== "model");
    expect(
      notInTs,
      `ReachClass(es) in manifest.rs that no surface in QUICKJS_SURFACE_REACH lists: ` +
        `${notInTs.join(", ")}. Either a class was added to the interpreter and the mirror ` +
        `was not updated, or a class is dead. ${FIX}`,
    ).toEqual([]);
    // ...and every class TS uses must exist in Rust.
    const notInRust = [...tsUsed].filter((t) => !rust.includes(t));
    expect(
      notInRust,
      `QUICKJS_SURFACE_REACH names reach class(es) manifest.rs does not define: ` +
        `${notInRust.join(", ")}. ${FIX}`,
    ).toEqual([]);
    // The human labels must cover every class, or the panel renders undefined.
    for (const cls of tsUsed) {
      expect(
        describeInterpreterReach([cls as InterpreterReachClass]),
        `describeInterpreterReach has no phrasing for reach class "${cls}" — add it to ` +
          `REACH_LABELS in app/src/api/codeInventory.ts. The transparency panel must never ` +
          `render a raw wire name (or "undefined") at the user.`,
      ).not.toMatch(/undefined/);
    }
  });

  it("every capability the interpreter can demand is in the one vocabulary", () => {
    const known = new Set<string>(ALL_CAPABILITY_IDS);
    const unknown = [...new Set(OPS.flatMap((o) => (o.capability ? [o.capability] : [])))].filter(
      (c) => !known.has(c),
    );
    expect(
      unknown,
      `OP_MANIFEST gates op(s) on capability id(s) that are not in ALL_CAPABILITY_IDS ` +
        `(app/src/api/scriptHost/capabilityIds.ts): ${unknown.join(", ")}. A capability the ` +
        `vocabulary does not know cannot be consented to, audited or revoked — add it to ` +
        `capabilityIds.ts (which also pins KNOWN_CAPABILITY_IDS in core/persistence) before ` +
        `the interpreter is allowed to demand it.`,
    ).toEqual([]);
  });

  it("a gated op is a model op and a model op is gated (no half-classified reach)", () => {
    const mismatched = OPS.filter((o) => (o.capability !== null) !== (o.reach === "model"));
    expect(
      mismatched.map((o) => `${o.path} (reach=${o.reach}, capability=${o.capability})`),
      `OP_MANIFEST row(s) pair a reach class and a capability inconsistently. Every ` +
        `capability-gated op must be ReachClass::Model and vice versa, or the per-surface ` +
        `derivation silently understates what a surface can be granted. ${FIX}`,
    ).toEqual([]);
  });

  it.each(Object.keys(QUICKJS_SURFACE_REACH) as QuickJsSurfaceId[])(
    "%s: reach + capability ceiling match the interpreter's derivation",
    (surfaceId) => {
      const profile = PROFILES.find((p) => p.id === surfaceId);
      expect(
        profile,
        `SURFACE_PROFILES in manifest.rs has no entry for "${surfaceId}", but ` +
          `QUICKJS_SURFACE_REACH claims to know its reach. Add the profile in Rust (with its ` +
          `model_provider / host_globals_deleted knobs and the host entry point), or drop the ` +
          `surface from the mirror. A reach claim with no profile behind it is exactly the ` +
          `asserted claim this guard exists to eliminate.`,
      ).toBeDefined();
      const p = profile as RustSurfaceProfile;

      expect(
        [...QUICKJS_SURFACE_REACH[surfaceId]],
        `QUICKJS_SURFACE_REACH["${surfaceId}"] disagrees with what manifest.rs derives for ` +
          `that surface (model_provider=${p.modelProvider}, ` +
          `host_globals_deleted=${p.hostGlobalsDeleted}, built at ${p.entryPoint}). ${FIX}`,
      ).toEqual(derivedReach(p, OPS));

      expect(
        [...QUICKJS_SURFACE_CAPABILITIES[surfaceId]].sort(),
        `QUICKJS_SURFACE_CAPABILITIES["${surfaceId}"] disagrees with manifest.rs. This is the ` +
          `number the panel turns into "grid-only" vs "can reach your BI model", so an ` +
          `understatement here is a lie to the user in the one direction that matters. ${FIX}`,
      ).toEqual(derivedCapabilities(p, OPS));
    },
  );

  it("the one-off surface is grid-only BECAUSE no model provider is injected", () => {
    // Pins the mechanism, not just the outcome. `mcp-tool` is deliberately NOT
    // in this loop any more: it DOES get a provider (see the entry-point test
    // below, which is the guard that would have caught the four-wave-long false
    // claim this list used to encode).
    const p = PROFILES.find((x) => x.id === "one-off-script") as RustSurfaceProfile;
    expect(
      p.modelProvider,
      `manifest.rs now records a ModelDataProvider on "one-off-script" (${p.entryPoint}). ` +
        `That surface is advertised as grid-only in scriptSurfaces.ts and in the transparency ` +
        `panel, and it has NO just-in-time consent UI, so injecting a provider there would ` +
        `hand ungated BI reach to code the user was told could not reach it. Either revert ` +
        `the injection or build consent + audit for that surface first.`,
    ).toBe(false);
    const validator = PROFILES.find((x) => x.id === "writeback-validator") as RustSurfaceProfile;
    expect(
      validator.hostGlobalsDeleted,
      `manifest.rs no longer records the writeback validator harness as deleting the host ` +
        `globals. A PUBLISHER-authored predicate would then run with the full Calcula/model/` +
        `display surface on the respondent's machine. Restore the deletion in ` +
        `app/src-tauri/src/calp_commands.rs (run_validator_batch) or correct the profile.`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (A cont.) THE ROOT FIX: the profile's flags are checked against the HOST CODE
// ---------------------------------------------------------------------------
//
// Everything above derives the TypeScript mirrors from manifest.rs. That closes
// the mirror gap and leaves one open: manifest.rs itself is HAND-WRITTEN about
// the call sites, and `model_provider` sat at `false` for `mcp-tool` through
// four waves while `mcp/tools.rs` injected a provider. Every downstream guard
// passed the whole time, because they all agreed with the wrong number.
//
// So this block reads the host sources the profiles NAME and re-derives the two
// facts from them. It is the only test here whose failure means "the manifest is
// lying", rather than "a mirror fell behind the manifest".

/** Everything outside a `//` line comment, so a scanner can never be satisfied
 *  (or alarmed) by prose. `calp_commands.rs` contains the sentence "no
 *  ModelDataProvider" in a comment, and mcp/tools.rs documents
 *  `HostModelProvider::model_info` in a doc comment. */
function withoutLineComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** The `app/src-tauri/...rs` path a profile's entry_point names (the text before
 *  the first " ->"). Requiring it to resolve is itself part of the guard: an
 *  entry point nobody can open is an assertion, not a citation. */
function entryPointFile(profile: RustSurfaceProfile): string {
  const rel = profile.entryPoint.split("->")[0].trim();
  expect(
    rel,
    `SURFACE_PROFILES entry for "${profile.id}" has an entry_point that does not begin with ` +
      `a repo-relative .rs path: "${profile.entryPoint}". The path is what makes the ` +
      `model_provider claim checkable — without it this guard cannot run.`,
  ).toMatch(/^app\/src-tauri\/src\/.+\.rs$/);
  const abs = path.join(REPO, rel);
  expect(fs.existsSync(abs), `entry_point file for "${profile.id}" does not exist: ${rel}`).toBe(
    true,
  );
  return fs.readFileSync(abs, "utf8");
}

describe("interpreter reach — manifest.rs profiles match the host call sites", () => {
  it.each(PROFILES.map((p) => p.id))(
    "%s: model_provider matches whether its entry-point file injects one",
    (id) => {
      const p = PROFILES.find((x) => x.id === id) as RustSurfaceProfile;
      const src = withoutLineComments(entryPointFile(p));
      // The ONE way a provider reaches the interpreter: constructing the host's
      // implementation. `NotebookSession::new(Some(...))` is the consumer, but
      // the construction is what cannot be faked.
      const injects = /HostModelProvider::new\s*\(/.test(src);
      expect(
        injects,
        injects
          ? `${p.entryPoint} CONSTRUCTS a HostModelProvider, but SURFACE_PROFILES records ` +
            `model_provider: false for "${id}". That understates the surface everywhere the ` +
            `claim is shown — codeInventory.ts, scriptSurfaces.ts and the "Code in This File" ` +
            `panel all derive from this flag, so the user is told the surface cannot reach ` +
            `their BI model while it can. Set model_provider: true (and give it a truthful ` +
            `\`granted\` list), or remove the injection.`
          : `SURFACE_PROFILES records model_provider: true for "${id}", but ${p.entryPoint} ` +
            `never constructs a HostModelProvider. Either the flag is stale or the injection ` +
            `moved to another file — in which case update entry_point, because an entry point ` +
            `that does not contain the construction cannot be audited.`,
      ).toBe(p.modelProvider);
    },
  );

  it("mcp-tool's granted list is exactly MCP_SCRIPT_CAPABILITIES", () => {
    // The grant half of the same root cause. A provider alone does not decide
    // reach: bi/script_provider.rs re-checks the capability store per call, so
    // the honest ceiling for this surface is the host's hard-coded grant list.
    const src = withoutLineComments(
      fs.readFileSync(path.join(REPO, "app/src-tauri/src/mcp/tools.rs"), "utf8"),
    );
    const m = src.match(/MCP_SCRIPT_CAPABILITIES\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/);
    expect(
      m,
      "MCP_SCRIPT_CAPABILITIES not found in app/src-tauri/src/mcp/tools.rs. It is the " +
        "authoritative grant list for the execute_script surface; if it was renamed, update " +
        "this guard and manifest.rs's `granted` together.",
    ).not.toBeNull();
    const hostGrants = [...(m as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map((g) => g[1]).sort();
    const profile = PROFILES.find((x) => x.id === "mcp-tool") as RustSurfaceProfile;
    expect(
      [...profile.granted].sort(),
      `SURFACE_PROFILES's \`granted\` for "mcp-tool" disagrees with MCP_SCRIPT_CAPABILITIES ` +
        `in mcp/tools.rs. Widening the host list without widening the profile understates an ` +
        `AI-driven surface that has NO consent prompt in front of it; narrowing it without ` +
        `narrowing the profile overstates it. ${FIX}`,
    ).toEqual(hostGrants);
    // And the TS mirror must be that same list.
    expect(
      [...QUICKJS_SURFACE_CAPABILITIES["mcp-tool"]].sort(),
      `QUICKJS_SURFACE_CAPABILITIES["mcp-tool"] disagrees with the host's own grant list. ${FIX}`,
    ).toEqual(hostGrants);
  });
});

// ---------------------------------------------------------------------------
// (A cont.) The taxonomy row for each rust-quickjs surface must match too
// ---------------------------------------------------------------------------

describe("interpreter reach — scriptSurfaces taxonomy rows are interpreter-derived", () => {
  const quickJsRows = SCRIPT_SURFACES.filter((s) => s.runtime === "rust-quickjs");

  it("every rust-quickjs taxonomy row has a Rust SurfaceProfile (and vice versa)", () => {
    const rowIds = quickJsRows.map((s) => s.id).sort();
    const profileIds = PROFILES.map((p) => p.id).sort();
    expect(
      profileIds,
      `The set of rust-quickjs surfaces in app/src/api/scriptSurfaces.ts and the set of ` +
        `SURFACE_PROFILES in core/script-engine/src/manifest.rs have diverged.\n` +
        `  taxonomy: ${rowIds.join(", ")}\n  manifest: ${profileIds.join(", ")}\n` +
        `A surface that runs code in the Rust interpreter without a profile has NO derived ` +
        `reach — its transparency claim would fall back to being asserted, which is the ` +
        `residual this guard closed. ${FIX}`,
    ).toEqual(rowIds);
    // The ids must also be real ScriptSurfaceIds, so a typo in Rust cannot
    // quietly create a profile that matches nothing.
    const known = new Set<string>(SCRIPT_SURFACES.map((s) => s.id));
    const bogus = profileIds.filter((id) => !known.has(id));
    expect(
      bogus,
      `SURFACE_PROFILES declares id(s) that are not ScriptSurfaceIds: ${bogus.join(", ")}. ${FIX}`,
    ).toEqual([]);
  });

  it.each(quickJsRows.map((s) => s.id))(
    "%s: the taxonomy's capability list equals the interpreter's derivation",
    (surfaceId: ScriptSurfaceId) => {
      const row = SCRIPT_SURFACES.find((s) => s.id === surfaceId)!;
      const p = PROFILES.find((x) => x.id === surfaceId) as RustSurfaceProfile;
      expect(
        [...row.capabilities].sort(),
        `The "${surfaceId}" row in app/src/api/scriptSurfaces.ts lists capabilities that do ` +
          `not match what core/script-engine/src/manifest.rs derives for it. scriptSurfaces.ts ` +
          `documents its own worker-realm rows as "derived-checked" but left the rust-quickjs ` +
          `rows self-asserted — this test is what removed that asymmetry. ${FIX}`,
      ).toEqual(derivedCapabilities(p, OPS));
    },
  );
});

// ---------------------------------------------------------------------------
// (B) The writeback-validator harness must account for EVERY realm root
// ---------------------------------------------------------------------------

describe("writeback validator harness — global deletion tracks the interpreter", () => {
  const calp = fs.readFileSync(CALP_COMMANDS_RS, "utf8");

  /** Roots of the realm: manifest paths with no dot, minus the synthetic
   *  Sheet/Range roots (which are objects handed out by function calls, not
   *  globals, so deleting them is meaningless — removing `Calcula` removes the
   *  only way to obtain one). */
  const SYNTHETIC_ROOTS = new Set(["Sheet", "Range"]);
  const roots = OPS.map((o) => o.path)
    .filter((p) => !p.includes(".") && !SYNTHETIC_ROOTS.has(p))
    .sort();

  /**
   * Roots the harness deliberately does NOT delete, each with the reason it is
   * inert on this surface. A NEW root must be classified here or deleted —
   * that is the fail-closed half. Note this list is defence in depth: the
   * reason each entry is safe is a property of the SURFACE (no model provider,
   * nonce-prefixed verdict), not of the sink.
   */
  //
  // EMPTY as of 2026-08-01, and that is the point. It previously acknowledged the
  // seven `__calcula_model_*` sinks and `__calcula_display_table` as "inert on
  // this surface" — true, but true because of a property of ANOTHER file (no
  // ModelDataProvider is installed for the validator surface) that could change
  // without anyone reading this list. The harness now deletes all eight, so the
  // realm claim rests on the harness itself.
  const ROOTS_LEFT_UNDELETED: Record<string, string> = {};

  /** `delete globalThis.X;` occurrences in the validator harness. */
  function deletedGlobals(): Set<string> {
    const start = calp.indexOf("fn run_validator_batch");
    expect(start, "run_validator_batch not found in calp_commands.rs").toBeGreaterThan(-1);
    const body = calp.slice(start, start + 6000);
    return new Set([...body.matchAll(/delete\s+globalThis\.(\w+)/g)].map((m) => m[1]));
  }

  it("every host global the interpreter registers is deleted or explicitly acknowledged", () => {
    const deleted = deletedGlobals();
    const unaccounted = roots.filter((r) => !deleted.has(r) && !(r in ROOTS_LEFT_UNDELETED));
    expect(
      unaccounted,
      `The Rust QuickJS realm registers global(s) that the writeback-validator harness ` +
        `neither deletes nor acknowledges: ${unaccounted.join(", ")}.\n\n` +
        `A writeback validator is PUBLISHER-authored code running on the respondent's ` +
        `machine, and the whole basis for consenting to it is that it opens onto a bare ` +
        `ECMAScript realm. FIX: add \`try { delete globalThis.<name>; } catch (e) {}\` to the ` +
        `harness in app/src-tauri/src/calp_commands.rs (run_validator_batch), or — only if the ` +
        `global is provably inert on this surface — add it to ROOTS_LEFT_UNDELETED in this ` +
        `test with the reason.`,
    ).toEqual([]);
  });

  it("the acknowledgement list has not gone stale", () => {
    const stale = Object.keys(ROOTS_LEFT_UNDELETED).filter((r) => !roots.includes(r));
    expect(
      stale,
      `ROOTS_LEFT_UNDELETED acknowledges global(s) the interpreter no longer registers: ` +
        `${stale.join(", ")}. Remove them, so the list keeps naming only live risk.`,
    ).toEqual([]);
    const redundant = Object.keys(ROOTS_LEFT_UNDELETED).filter((r) => deletedGlobals().has(r));
    expect(
      redundant,
      `ROOTS_LEFT_UNDELETED acknowledges global(s) the harness DOES delete: ` +
        `${redundant.join(", ")}. Drop the acknowledgement — the stronger fix already shipped.`,
    ).toEqual([]);
  });

  it("the guard actually fires for a new undeleted global", () => {
    // Self-test: prove the assertion above is not vacuous.
    const deleted = deletedGlobals();
    const withNew = [...roots, "net"];
    const unaccounted = withNew.filter((r) => !deleted.has(r) && !(r in ROOTS_LEFT_UNDELETED));
    expect(unaccounted).toEqual(["net"]);
    // ...and that it really is reading the harness (not an empty set). Every
    // root the interpreter registers is now deleted by name — no exceptions,
    // which is why ROOTS_LEFT_UNDELETED above is empty.
    expect([...deleted].sort()).toEqual([...roots].sort());
    expect(deleted.size).toBeGreaterThanOrEqual(11);
  });
});
