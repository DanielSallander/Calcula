//! FILENAME: app/src/api/scriptHost/__tests__/scriptOriginForgery.test.ts
// PURPOSE: An application a publisher NAMES `local` must be treated as
//          DISTRIBUTED at every gate and in every band. One file, one adversary:
//          `packageName: "local"`.
// CONTEXT: `ScriptHandle.origin` used to be a `string` carrying two different
//          things in one namespace — the sentinel `"local"` for workbook code,
//          and the publisher-chosen application name for distributed code. Four
//          security gates and two provenance bands read that sentinel, so
//          choosing a name bought:
//            1. the LOCAL JIT-prompt path (capabilities from a prompt in the
//               moment instead of from package consent, a higher bar),
//            2. restoration of capability grants persisted for a LOCAL script,
//            3. persistence of its own grants into that local store,
//            4. same-trust-origin with the user's own scripts — reach to their
//               NON-PUBLIC exposed methods and their forms,
//            5/6. a ui.dialog band and a Permissions-panel chip claiming the
//               code came from this workbook.
//
//          The fix is structural: `ScriptOrigin` (scriptHost/scriptOrigin.ts) is
//          a discriminated union, so `origin === "local"` no longer type-checks
//          and no publisher-typed value can land in `kind`. EVERY test below
//          fails against the old string — the assertions named in each `it` are
//          the ones that go red.
//
//          The band tests live with their renderers (scriptDialogPromptBand and
//          scriptFormDialog under extensions/ScriptableObjects/__tests__); this
//          file pins the gates and the derivation they all share.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Backend double — capabilities.ts pushes the live grant set to Rust on restore.
// ---------------------------------------------------------------------------
const invokeMock = vi.fn(async () => undefined as unknown);
vi.mock("../../backend", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeBackend: (...a: unknown[]) => invokeMock(...(a as [])),
}));

// ---------------------------------------------------------------------------
// The persisted-grant store. Real module, two functions spied: these are the
// exact calls gates (2) and (3) must never make for a distributed script.
// ---------------------------------------------------------------------------
const restoreSpy = vi.fn(async () => ({
  capabilities: ["schedule"] as string[],
  netOrigins: [] as string[],
  lapseNotice: null as string | null,
}));
const persistSpy = vi.fn(async () => {});
vi.mock("../../scriptSecurity", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restorePersistedScriptCapabilityGrant: (...a: unknown[]) => restoreSpy(...(a as [])),
  persistScriptCapabilityGrant: (...a: unknown[]) => persistSpy(...(a as [])),
}));

import {
  buildHandleFromDefinition,
  buildPreviewHandle,
  sameTrustOrigin,
  registerExposed,
  callExposed,
  clearExposed,
  BrokerError,
  type ScriptHandle,
} from "../broker";
import {
  getGrantSet,
  persistAlwaysGrant,
  resetAllGrants,
  restoreAndSyncGrants,
} from "../capabilities";
import { mayJitPromptForCapability } from "../host";
import { formOriginForMount } from "../scriptFormSpec";
import {
  LOCAL_ORIGIN,
  accessLevelForOrigin,
  isLocalOrigin,
  mountProvenanceForOrigin,
  originPackageName,
  originTagLabel,
  originTagTitle,
  packageOrigin,
  sameScriptOrigin,
  scriptOriginForMount,
  scriptOriginForStoredRecord,
} from "../scriptOrigin";

// ---------------------------------------------------------------------------
// Fixtures — the adversary and its honest neighbours
// ---------------------------------------------------------------------------

/** A DISTRIBUTED script whose publisher named the application exactly `local`. */
function packageNamedLocal(id = "pkg-local-1"): ScriptHandle {
  return buildHandleFromDefinition({
    id,
    name: "Quarterly Report",
    objectType: "workbook",
    instanceId: null,
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: "local",
    declaredCapabilities: ["schedule", "net.fetch"],
  });
}

/** A workbook-authored script — what the adversary is trying to be mistaken for. */
function localScript(id = "own-1"): ScriptHandle {
  return buildHandleFromDefinition({
    id,
    name: "My button",
    objectType: "button",
    instanceId: "b1",
    accessLevel: "restricted",
    provenance: "local",
    declaredCapabilities: ["schedule"],
  });
}

/** An honestly-named distributed script, for the "nothing else changed" half. */
function packageNamed(name: string, id = `pkg-${name}`): ScriptHandle {
  return buildHandleFromDefinition({
    id,
    name: `${name} script`,
    objectType: "workbook",
    instanceId: null,
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: name,
    declaredCapabilities: [],
  });
}

beforeEach(() => {
  resetAllGrants();
  invokeMock.mockClear();
  restoreSpy.mockClear();
  persistSpy.mockClear();
  clearExposed();
});

// ===========================================================================
describe("the derivation itself", () => {
  it("puts the publisher's name in `.name` and never in `.kind`", () => {
    const handle = packageNamedLocal();
    // OLD STRING: `origin` was the string "local" — indistinguishable from the
    // sentinel, which is the whole defect.
    expect(handle.origin).toEqual({ kind: "package", name: "local" });
    expect(isLocalOrigin(handle.origin)).toBe(false);
    expect(localScript().origin).toEqual({ kind: "local" });
  });

  it("derives the origin from `provenance`, never from the name", () => {
    // A LOCAL script carrying a package name is still local; a distributed one
    // with no name gets the placeholder, not a chance at the local kind.
    expect(scriptOriginForMount({ provenance: "local", packageName: "Sales Pack" })).toEqual({
      kind: "local",
    });
    expect(scriptOriginForMount({ provenance: "distributed" })).toEqual({
      kind: "package",
      name: "(unknown package)",
    });
    expect(scriptOriginForMount({ provenance: "distributed", packageName: "local" })).toEqual({
      kind: "package",
      name: "local",
    });
  });

  it("the trust handle and the form band agree about the same definition", () => {
    // They were derived separately once — the band was fixed first, while the
    // handle was still a string. Two derivations of one fact is how a band and a
    // gate come to different conclusions about the same script.
    const definition = { provenance: "distributed", packageName: "local" };
    expect(formOriginForMount(definition)).toEqual(scriptOriginForMount(definition));
    expect(buildHandleFromDefinition({
      id: "x",
      name: "x",
      objectType: "workbook",
      instanceId: null,
      accessLevel: "restricted",
      ...definition,
    }).origin).toEqual(formOriginForMount(definition));
  });
});

// ===========================================================================
describe("gate 1 — the JIT capability prompt (host.ts)", () => {
  it("refuses the local prompt path to a package named `local`", () => {
    // OLD STRING: the gate was `handle.origin !== "local"`, which for this
    // handle was `"local" !== "local"` -> false -> it fell through and prompted.
    expect(mayJitPromptForCapability(packageNamedLocal())).toBe(false);
  });

  it("still offers it to workbook-authored code, and still refuses every package", () => {
    expect(mayJitPromptForCapability(localScript())).toBe(true);
    expect(mayJitPromptForCapability(packageNamed("Acme Reports"))).toBe(false);
    expect(
      mayJitPromptForCapability(
        buildPreviewHandle({
          scriptId: "preview:1",
          scriptName: "(preview)",
          objectType: "button",
          instanceId: null,
          tier: "restricted",
        }),
      ),
    ).toBe(false);
  });
});

// ===========================================================================
describe("gate 2 — restoring persisted grants (capabilities.ts)", () => {
  it("does not restore a LOCAL script's persisted grants for a package named `local`", async () => {
    const handle = packageNamedLocal("restore-victim");
    await restoreAndSyncGrants({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      source: "function setup(){}",
      origin: handle.origin,
      declaredCapabilities: handle.declaredCapabilities,
    });
    // OLD STRING: `target.origin === "local"` was TRUE, so the store was read
    // and its "schedule" grant landed in the live set for a distributed script.
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getGrantSet("restore-victim").has("schedule")).toBe(false);
  });

  it("still restores them for a real local script (the positive control)", async () => {
    // The origin comes off a REAL handle, never hand-built here: a fixture that
    // constructs the value it is testing would keep passing against the old
    // string, which is exactly the sabotage this file has to fail against.
    const handle = localScript();
    await restoreAndSyncGrants({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      source: "function setup(){}",
      origin: handle.origin,
      declaredCapabilities: ["schedule"],
    });
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(getGrantSet("own-1").has("schedule")).toBe(true);
  });
});

// ===========================================================================
describe("gate 3 — persisting an 'Always' grant (capabilities.ts)", () => {
  it("never persists into the local store for a package named `local`", async () => {
    const handle = packageNamedLocal();
    expect(handle.origin).toEqual(packageOrigin("local"));
    await persistAlwaysGrant({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      source: "function setup(){}",
      origin: handle.origin,
      capability: "schedule",
    });
    // OLD STRING: `args.origin !== "local"` was FALSE, so it fell through and
    // wrote a distributed script's grant into the workbook's local-script store,
    // outside the package-consent record that is supposed to hold it.
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("still persists for a real local script (the positive control)", async () => {
    const handle = localScript();
    expect(handle.origin).toEqual(LOCAL_ORIGIN);
    await persistAlwaysGrant({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      source: "function setup(){}",
      origin: handle.origin,
      capability: "schedule",
    });
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe("gate 4 — sameTrustOrigin (broker.ts, the R7 predicate)", () => {
  it("a package named `local` is NOT same-origin with a workbook script", () => {
    // OLD STRING: both sides were the string "local" and both restricted, so
    // `a.origin === b.origin` was true and the package was same-trust with the
    // user's own code.
    expect(sameTrustOrigin(packageNamedLocal(), localScript())).toBe(false);
    expect(sameTrustOrigin(localScript(), packageNamedLocal())).toBe(false);
  });

  it("so it cannot call a local script's NON-PUBLIC exposed method", async () => {
    const owner = localScript();
    const attacker = packageNamedLocal();
    const handler = vi.fn(() => "secret");
    registerExposed(owner, "internalTotals", handler, /* isPublic */ false);

    await expect(
      callExposed(attacker, owner.objectType, owner.instanceId, "internalTotals", []),
    ).rejects.toBeInstanceOf(BrokerError);
    expect(handler).not.toHaveBeenCalled();

    // Positive control: the owner's own peer still reaches it.
    const peer = localScript("own-2");
    await expect(
      callExposed(peer, owner.objectType, owner.instanceId, "internalTotals", []),
    ).resolves.toBe("secret");
  });

  it("the honest cases are unchanged", () => {
    // Two scripts from the same package are same-origin...
    expect(sameTrustOrigin(packageNamed("Acme", "a1"), packageNamed("Acme", "a2"))).toBe(true);
    // ...two from DIFFERENT packages are not...
    expect(sameTrustOrigin(packageNamed("Acme", "a1"), packageNamed("Beta", "b1"))).toBe(false);
    // ...two local scripts are...
    expect(sameTrustOrigin(localScript("l1"), localScript("l2"))).toBe(true);
    // ...and tier still separates otherwise-identical origins.
    const unlockedLocal = buildHandleFromDefinition({
      id: "l3",
      name: "unlocked",
      objectType: "button",
      instanceId: "b1",
      accessLevel: "unlocked",
      provenance: "local",
    });
    expect(sameTrustOrigin(unlockedLocal, localScript("l4"))).toBe(false);
  });

  it("a preview is same-origin with nothing, including another preview", () => {
    const p = (id: string): ScriptHandle =>
      buildPreviewHandle({
        scriptId: id,
        scriptName: "(preview)",
        objectType: "button",
        instanceId: "b1",
        tier: "restricted",
      });
    expect(sameTrustOrigin(p("p1"), p("p2"))).toBe(false);
    expect(sameTrustOrigin(p("p1"), localScript())).toBe(false);
    expect(sameTrustOrigin(p("p1"), packageNamedLocal())).toBe(false);
    // The old `"(preview)"` string made two previews same-origin with each other.
    expect(sameScriptOrigin(p("p1").origin, p("p2").origin)).toBe(false);
  });
});

// ===========================================================================
describe("the transparency surfaces still show the NAME, not an encoding", () => {
  it("names the package a package, even when the package is named `local`", () => {
    const origin = packageNamedLocal().origin;
    // The chip in the Permissions panel: the name is displayed, the KIND decides
    // which style and which tooltip. OLD STRING: label and tooltip both said this
    // was authored in the user's own workbook.
    expect(originTagLabel(origin)).toBe("local");
    expect(originTagTitle(origin)).toBe('From package "local"');
    expect(isLocalOrigin(origin)).toBe(false);
    // The transparency panel's owner column (codeInventory).
    expect(originPackageName(origin)).toBe("local");
    // ...and a genuinely local script still reports no package at all.
    expect(originPackageName(LOCAL_ORIGIN)).toBeNull();
    expect(originTagLabel(LOCAL_ORIGIN)).toBe("local");
    expect(originTagTitle(LOCAL_ORIGIN)).toBe("Authored in this workbook");
  });

  it("an honestly-named package is displayed by its name", () => {
    const origin = packageNamed("Acme Reports").origin;
    expect(originTagLabel(origin)).toBe("Acme Reports");
    expect(originPackageName(origin)).toBe("Acme Reports");
    expect(originTagTitle(origin)).toBe('From package "Acme Reports"');
  });
});

// ===========================================================================
// The drift guard — the losing option stays impossible
// ===========================================================================
//
// A prefix scheme ("pkg:" + name) would have closed the hole with less churn and
// left a STRING that still looks comparable, so the next gate would be written
// with the same syntax and the same bug. The union removes the syntax: in typed
// product code `origin === "local"` no longer compiles. This guard is the second
// half of "impossible rather than merely unused" — it fails if anyone reverts
// the field to a string and starts comparing it again, which is exactly what a
// revert of this fix looks like.
//
// It also pins `maybeRequestCapabilityGrant` (host.ts), the one gate reachable
// only through a live Worker realm: its body must ask the shared predicate,
// never a string.

/** Source with `//` and block comments removed, so PROSE about the old defect
 *  (which quotes the bad comparison verbatim, on purpose) is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function tsFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

/** app/ — this file is app/src/api/scriptHost/__tests__/x.test.ts. */
const APP_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Every tree that builds a mount definition or reads a trust origin.
 *
 * `src/shell` belongs here and was missing: the Extension Manager builds a
 * handle definition of its own (`buildHandleFromDefinition`, ExtensionManager.ts)
 * for every distributed extension it loads, so a `provenance: "local"` written
 * there would have been as damaging as one in `src/api` and no guard was
 * looking at it. `src/core` is deliberately absent — it may not import the
 * script host at all (the Alien Rule), and a boundary lint already says so.
 */
const SCANNED_ROOTS = [
  join(APP_ROOT, "src", "api"),
  join(APP_ROOT, "src", "shell"),
  join(APP_ROOT, "extensions"),
];

/** Every product .ts/.tsx file under the scanned roots. */
function scannedFiles(): string[] {
  return SCANNED_ROOTS.flatMap((root) => tsFilesUnder(root));
}

/** Repo-relative, forward-slashed — what an offender line is reported as. */
function relPath(file: string): string {
  return relative(APP_ROOT, file).split(sep).join("/");
}

/**
 * `origin === "..."` in either direction, on any expression whose last identifier
 * ends in `origin`/`Origin` — `handle.origin`, `target.origin`, `scriptOrigin`,
 * and a bare `origin` alike.
 *
 * The `[\w$]*` before `[Oo]rigin` MUST be allowed to be empty. A first draft made
 * it mandatory, so `handle.origin !== "local"` — the exact line this whole change
 * removes — did not match, and the guard reported ONE offender against a
 * full revert that had planted six. A guard that finds a sixth of the defect is
 * a guard that will miss the next one.
 */
const ORIGIN_STRING_COMPARE =
  /(?:^|[^\w$])[\w$]*[Oo]rigin\s*[!=]==?\s*["'`]|["'`][^"'`\n]*["'`]\s*[!=]==?\s*[\w$.]*[Oo]rigin(?![\w$])/;

describe("nothing compares a trust origin to a string", () => {
  it("holds across src/api, src/shell and the extensions", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        if (ORIGIN_STRING_COMPARE.test(line)) {
          offenders.push(`${relPath(file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "a trust origin is a discriminated union; comparing one to a string is the " +
        "defect this module exists to make unwriteable (branch on `.kind`)",
    ).toEqual([]);
  });

  it("maybeRequestCapabilityGrant asks the predicate, not a name", () => {
    // Reachable only through a live Worker realm, so it is pinned by shape. The
    // OLD line — `if (handle.origin !== "local" || cap === "ui.html") return;` —
    // fails both assertions.
    const host = stripComments(
      readFileSync(join(APP_ROOT, "src", "api", "scriptHost", "host.ts"), "utf8"),
    );
    const start = host.indexOf("async function maybeRequestCapabilityGrant(");
    expect(start, "maybeRequestCapabilityGrant must still exist").toBeGreaterThan(-1);
    const body = host.slice(start, host.indexOf("\n}\n", start));
    expect(body).toContain("mayJitPromptForCapability(handle)");
    expect(ORIGIN_STRING_COMPARE.test(body)).toBe(false);
  });
});

// ===========================================================================
// THE SAME DEFECT, ONE LAYER UP: PROVENANCE FABRICATED AT A CALL SITE.
//
// The union closed the door on a publisher CHOOSING the local kind. It could not
// close the door on a call site simply WRITING it: `runObjectScriptOnce` and
// `hostStartModuleScriptDebugSession` each hard-coded `provenance: "local"` and
// the `unlocked` tier for module scripts — and a `.calp` may ship module
// scripts, which `core/calp/src/pull.rs` materializes into the subscriber's
// workbook stamped with `source_package`. Subscribing to an application and
// pressing Run therefore executed the publisher's code at the TOP tier under the
// user's own identity, which also routed its capability requests to the local
// JIT prompt instead of application consent.
//
// The fix is the same shape as the union's: there is now exactly ONE place that
// writes the string, and every mount spells the derivation instead.
// ===========================================================================

describe("the origin of a STORED artifact is derived from its record", () => {
  it("a source package makes it a package origin; nothing else does", () => {
    expect(scriptOriginForStoredRecord({ sourcePackage: "Acme Finance Pack" })).toEqual({
      kind: "package",
      name: "Acme Finance Pack",
    });
    expect(scriptOriginForStoredRecord({ sourcePackage: null })).toEqual({ kind: "local" });
    expect(scriptOriginForStoredRecord({})).toEqual({ kind: "local" });
    // A blank stamp is nothing stamped — not an unnamed publisher.
    expect(scriptOriginForStoredRecord({ sourcePackage: "  " })).toEqual({ kind: "local" });
    // ...and a publisher who names the application `local` still gets a PACKAGE.
    expect(scriptOriginForStoredRecord({ sourcePackage: "local" })).toEqual({
      kind: "package",
      name: "local",
    });
  });

  it("a package origin caps the tier at restricted, whatever was asked for", () => {
    const theirs = packageOrigin("Acme Finance Pack");
    expect(accessLevelForOrigin(theirs, "unlocked")).toBe("restricted");
    expect(accessLevelForOrigin(theirs, "restricted")).toBe("restricted");
    // Local code keeps the caller's choice — for local code the tier IS the
    // user's decision.
    expect(accessLevelForOrigin(LOCAL_ORIGIN, "unlocked")).toBe("unlocked");
    expect(accessLevelForOrigin(LOCAL_ORIGIN, "restricted")).toBe("restricted");
  });

  it("round-trips through the mount fields it produces", () => {
    for (const origin of [LOCAL_ORIGIN, packageOrigin("Acme"), packageOrigin("local")]) {
      expect(scriptOriginForMount(mountProvenanceForOrigin(origin))).toEqual(origin);
    }
  });
});

/**
 * A `provenance:` field ASSERTED as the local sentinel.
 *
 * Only the "local" direction is a defect. Writing `provenance: "distributed"` at
 * a call site can only ever NARROW what the code may do — the extension-worker
 * host, the library linker and the writeback validators all do it for artifacts
 * that are distributed by construction. Claiming "local" is the direction that
 * grants: it buys the JIT-prompt path, the local persisted-grant store, and
 * same-trust-origin with the user's own scripts.
 *
 * The negative lookahead skips TYPE positions — `provenance: "local" |
 * "distributed"` is a declaration of the field, not an assertion of a value.
 */
const LOCAL_PROVENANCE_LITERAL = /\bprovenance\s*:\s*["'`]local["'`](?!\s*\|)/;

/**
 * The object literal handed to `hostMountScript({ … })`, from the `{` to its
 * matching `}`.
 *
 * Brace counting is enough here: the argument is always a literal written in
 * place (there is no call site that builds one elsewhere and passes a variable
 * except `hostStartModuleScriptDebugSession`, which has its own pinned test
 * below), and a `${…}` inside a template literal is itself balanced.
 */
function mountDefinitionLiterals(code: string): string[] {
  const out: string[] = [];
  const CALL = "hostMountScript({";
  for (let at = code.indexOf(CALL); at !== -1; at = code.indexOf(CALL, at + 1)) {
    let depth = 0;
    let i = at + CALL.length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(at, i + 1));
  }
  return out;
}

describe("nothing writes a provenance literal into a mount", () => {
  it("only mountProvenanceForOrigin spells it", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const rel = relPath(file);
      // The ONE derivation. It is allowed to write the strings; that is its job.
      if (rel === "src/api/scriptHost/scriptOrigin.ts") continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        if (LOCAL_PROVENANCE_LITERAL.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "a mount's provenance must be DERIVED from the artifact (mountProvenanceForOrigin " +
        "over scriptOriginForStoredRecord / scriptOriginForMount), never asserted at the " +
        "call site — a `.calp` ships module scripts, and a hard-coded \"local\" hands the " +
        "publisher the local JIT-prompt path and the unlocked tier",
    ).toEqual([]);
  });

  it("...and every mount SETTLES it, because omitting it is the same defect", () => {
    // THE HALF THE LITERAL GUARD COULD NOT SEE. `provenance` is optional on a
    // mount definition and `scriptOriginForMount` reads anything that is not
    // "distributed" as LOCAL — so a call site that simply LEAVES THE FIELD OUT
    // buys everything the banned literal buys: the local JIT-prompt path, the
    // local persisted-grant store, same-trust-origin with the user's own
    // scripts, and a transparency chip that says "authored in this workbook".
    // The Custom Functions library mounted publisher-merged UDF bodies exactly
    // that way, and this guard is what would have caught it.
    //
    // A call site settles it by SPREADING the derivation (the healthy form) or
    // by naming the field explicitly — in which case the literal guard above
    // still forbids the one value that grants.
    const offenders: string[] = [];
    let inspected = 0;
    for (const file of scannedFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const literal of mountDefinitionLiterals(code)) {
        inspected++;
        if (/mountProvenanceForOrigin\(|\bprovenance\s*:/.test(literal)) continue;
        offenders.push(`${relPath(file)}: ${literal.split("\n")[1]?.trim() ?? literal}`);
      }
    }
    // A parser that silently matched nothing would "pass" forever.
    expect(inspected, "the mount-definition scanner found no call sites at all").toBeGreaterThan(4);
    expect(
      offenders,
      "a mount definition must SETTLE its provenance — spread mountProvenanceForOrigin(origin) " +
        "over an origin derived from the artifact, or name the field explicitly. An omitted " +
        "`provenance` is read as LOCAL, which is the direction that grants: the JIT prompt, " +
        "the local grant store, and same-origin trust with the user's own scripts",
    ).toEqual([]);
  });

  it("the one-off runner resolves the artifact before it mounts anything", () => {
    const runner = stripComments(
      readFileSync(join(APP_ROOT, "src", "api", "objectScriptRunner.ts"), "utf8"),
    );
    // It asks the store, it caps the tier, and it spells the provenance once.
    expect(runner).toContain("resolveArtifactOrigin(");
    expect(runner).toContain("accessLevelForOrigin(");
    expect(runner).toContain("mountProvenanceForOrigin(origin)");
    // ...and the resolution happens BEFORE the mount, not after it.
    expect(runner.indexOf("resolveArtifactOrigin({ scriptId, source })")).toBeLessThan(
      runner.indexOf("hostMountScript("),
    );
  });

  it("the module debug session derives its tier from the record", () => {
    const host = stripComments(
      readFileSync(join(APP_ROOT, "src", "api", "scriptHost", "host.ts"), "utf8"),
    );
    const start = host.indexOf("export async function hostStartModuleScriptDebugSession");
    expect(start, "hostStartModuleScriptDebugSession must still exist").toBeGreaterThan(-1);
    const body = host.slice(start, host.indexOf("\n}\n", start));
    expect(body).toContain("scriptOriginForStoredRecord(record)");
    expect(body).toContain("mountProvenanceForOrigin(origin)");
    // No unconditional unlocked tier: the assignment is a conditional on the
    // origin's kind.
    expect(body).not.toMatch(/accessLevel:\s*["'`]unlocked["'`]\s*,/);
    expect(body).toMatch(/accessLevel:\s*origin\.kind === "package"/);
  });
});
