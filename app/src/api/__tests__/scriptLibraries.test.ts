//! FILENAME: app/src/api/__tests__/scriptLibraries.test.ts
// PURPOSE: The contract tests for shared script libraries (@api/scriptLibraries).
// CONTEXT: docs/design/script-package-manager.md §8. The confused-deputy test is
//          the most important one in the file: a library MUST NOT be able to
//          widen its consumer's capability ceiling.
//
// FIDELITY NOTE — why these are not shallow mocks. `hostMountScript` is replaced
// with an in-process fake that does what the real worker host does on mount:
// builds the handle with `buildHandleFromDefinition` (the REAL broker function,
// so the R19 ceiling is the real one) and EXECUTES the generated source with a
// context whose `expose`/`callMethod` route through the REAL broker
// (`registerExposed` / `callExposed`). So the token gate, the export routing,
// the cross-origin `public:` rule and the ceiling denial are all exercised for
// real; only the Worker boundary and the Rust backend are stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";

// jsdom has no WebCrypto subtle digest; sha256Hex (consent + lockfile identity)
// needs it, and the linker needs getRandomValues.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// ---------------------------------------------------------------------------
// In-memory workbook virtual filesystem + backend stub
// ---------------------------------------------------------------------------

const vfs = new Map<string, string>();
const invokeBackend = vi.fn(async (cmd: string) => {
  if (cmd === "library_resolve") return [];
  return undefined;
});

vi.mock("../backend", () => ({
  invokeBackend: (...a: unknown[]) => invokeBackend(...(a as [string])),
  readVirtualFile: async (p: string) => {
    if (!vfs.has(p)) throw new Error(`no such file: ${p}`);
    return vfs.get(p)!;
  },
  createVirtualFile: async (p: string, c = "") => {
    vfs.set(p, c);
  },
  deleteVirtualFile: async (p: string) => {
    vfs.delete(p);
  },
  listVirtualFiles: async () => [...vfs.keys()].map((path) => ({ path })),
}));

// ---------------------------------------------------------------------------
// Fake worker host: real handle, real broker registration, real execution
// ---------------------------------------------------------------------------

import {
  buildHandleFromDefinition,
  registerExposed,
  callExposed,
  clearExposed,
  brokerCall,
  BrokerError,
  type ScriptHandle,
} from "../scriptHost/broker";

interface FakeRealm {
  handle: ScriptHandle;
  definition: Record<string, unknown>;
  cleanups: Array<() => void>;
}

const realms = new Map<string, FakeRealm>();
const mountSpecs: Array<Record<string, unknown>> = [];

/** The context a mounted script sees. Mirrors the real shims' two relevant
 *  members; everything else a library could need is out of scope here. */
function makeContext(handle: ScriptHandle, cleanups: Array<() => void>): Record<string, unknown> {
  return {
    expose(name: string, fn: (...a: unknown[]) => unknown, opts?: { public?: boolean }) {
      cleanups.push(registerExposed(handle, name, fn, opts?.public === true));
    },
    callMethod(targetType: string, instanceId: string | null, method: string, ...args: unknown[]) {
      return callExposed(handle, targetType, instanceId, method, args);
    },
    log() {},
  };
}

function runSource(source: string, context: unknown): void {
  // Same shape as worker/bootstrap.ts's compile wrapper.
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "context",
    `${source}\n; return typeof setup === "function" ? setup(context) : undefined;`,
  );
  fn(context);
}

const hostMountScript = vi.fn(async (definition: Record<string, unknown>) => {
  mountSpecs.push(definition);
  const handle = buildHandleFromDefinition(definition as never);
  const cleanups: Array<() => void> = [];
  runSource(definition.source as string, makeContext(handle, cleanups));
  realms.set(definition.id as string, { handle, definition, cleanups });
});

const hostUnmountScript = vi.fn((id: string) => {
  const realm = realms.get(id);
  if (!realm) return;
  for (const c of realm.cleanups) c();
  realms.delete(id);
});

vi.mock("../scriptHost/host", () => ({
  hostMountScript: (d: Record<string, unknown>) => hostMountScript(d),
  hostUnmountScript: (id: string) => hostUnmountScript(id),
  hostResetAll: () => undefined,
}));

// Grants are the Rust store's business; here we only need them to land in the
// live in-memory set so the broker's grant check passes for CEILING-allowed caps.
vi.mock("../scriptHost/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scriptHost/capabilities")>();
  return {
    ...actual,
    applyConsentedCapabilities: async (scriptId: string, caps: string[]) => {
      for (const c of caps) actual.recordCapabilityGrant(scriptId, c as never);
    },
    restoreAndSyncGrants: async () => undefined,
  };
});

import {
  parseUses,
  parseExports,
  parseModulePragmas,
  intersectCeiling,
  chainCeiling,
  minTier,
  linkScript,
  listLibraryRealms,
  resetScriptLibraryRealms,
  generateLibraryRealmSource,
  generatePrelude,
  generateImportsTypings,
  commitLockedLibraries,
  loadLockfile,
  removeLockedLibrary,
  consentKeyFor,
  LibraryLinkError,
  type LockedLibrary,
} from "../scriptLibraries";
import { recordConsent, sha256Hex } from "../distributedConsent";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATS_SOURCE = [
  "// @export mean",
  "// @export scale",
  "function library(context) {",
  "  return {",
  "    mean: (values) => values.reduce((a, b) => a + b, 0) / values.length,",
  "    scale: (values, k) => values.map((v) => v * k),",
  "  };",
  "}",
].join("\n");

/** A library that WANTS the network. The confused-deputy fixture. */
const HTTP_SOURCE = [
  "// @capability net.fetch",
  "// @export post",
  "function library(context) {",
  "  return { post: async (url, body) => await context.caps.net.fetch(url, body) };",
  "}",
].join("\n");

async function installLibrary(opts: {
  pkg: string;
  version: string;
  pin?: string;
  modules: Array<{ id: string; source: string }>;
  uses?: LockedLibrary["uses"];
  requiredBy?: string[];
}): Promise<void> {
  const sources = new Map<string, string>();
  const modules = [];
  for (const m of opts.modules) {
    const hash = await sha256Hex(m.source);
    sources.set(hash, m.source);
    const pragmas = parseModulePragmas(m.source).pragmas;
    modules.push({
      id: m.id,
      name: m.id,
      sourceHash: hash,
      artifactSha256: hash,
      exports: pragmas.exports,
      capabilities: pragmas.capabilities,
      netOrigins: pragmas.netOrigins,
    });
  }
  await commitLockedLibraries(
    [
      {
        package: opts.pkg,
        pin: opts.pin ?? `^${opts.version}`,
        resolved: opts.version,
        registry: "C:/registry",
        publisherKey: "aa".repeat(32),
        publisherName: "Test Publisher",
        modules,
        uses: opts.uses ?? [],
        requiredBy: opts.requiredBy ?? [],
        installedAt: new Date().toISOString(),
      },
    ],
    sources,
  );
  await recordConsent(
    consentKeyFor(opts.pkg),
    opts.modules.map((m) => ({ id: m.id, source: m.source })),
    modules.flatMap((m) => m.capabilities).map((capability) => ({ capability })),
  );
}

/** Mount a consumer script the way ObjectScriptManager does: link, then run the
 *  prelude + source in a realm, and return its evaluated `imports` binding. */
async function mountConsumer(opts: {
  id: string;
  source: string;
  capabilities?: string[];
  tier?: "restricted" | "unlocked";
}): Promise<{ handle: ScriptHandle; imports: Record<string, Record<string, (...a: unknown[]) => unknown>>; release: () => void }> {
  const link = await linkScript({
    scriptId: opts.id,
    scriptName: opts.id,
    source: opts.source,
    declaredCapabilities: (opts.capabilities ?? []) as never,
    accessLevel: opts.tier ?? "restricted",
  });
  const handle = buildHandleFromDefinition({
    id: opts.id,
    name: opts.id,
    objectType: "workbook",
    instanceId: opts.id,
    accessLevel: opts.tier ?? "restricted",
    declaredCapabilities: opts.capabilities ?? [],
  });
  const cleanups: Array<() => void> = [];
  const context = makeContext(handle, cleanups);
  // eslint-disable-next-line no-new-func
  const fn = new Function("context", `${link.prelude}${opts.source}\n; return imports;`);
  const imports = fn(context);
  return { handle, imports, release: link.release };
}

beforeEach(() => {
  vfs.clear();
  realms.clear();
  mountSpecs.length = 0;
  clearExposed();
  resetScriptLibraryRealms();
  hostMountScript.mockClear();
  hostUnmountScript.mockClear();
});

// ===========================================================================
// 1. Pragma dialect
// ===========================================================================

describe("// @uses pragma", () => {
  it("parses alias, package and pin, and the -isolated modifier", () => {
    const { uses, errors } = parseUses(
      ["// @uses stats acme.stats@^1.2.0", "// @uses-isolated vault acme.vault@2.0.1"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(uses).toEqual([
      { alias: "stats", package: "acme.stats", pin: "^1.2.0", isolated: false },
      { alias: "vault", package: "acme.vault", pin: "2.0.1", isolated: true },
    ]);
  });

  it("reports a duplicate alias instead of silently picking one", () => {
    const { uses, errors } = parseUses(
      ["// @uses s a.one@1.0.0", "// @uses s a.two@1.0.0"].join("\n"),
    );
    expect(uses).toHaveLength(1);
    expect(errors.join()).toMatch(/declared more than once/);
  });

  it("reports a malformed pin and a non-identifier alias", () => {
    expect(parseUses("// @uses s acme.stats@not-a-version").errors.join()).toMatch(
      /not a valid version pin/,
    );
    expect(parseUses("// @uses 9bad acme.stats@1.0.0").errors.join()).toMatch(/not a valid alias/);
    expect(parseUses("// @uses s acme.stats").errors.join()).toMatch(/not a <package>@<pin>/);
  });

  it("rejects an alias that would shadow the generated binding", () => {
    expect(parseUses("// @uses imports acme.stats@1.0.0").errors.join()).toMatch(/reserved/);
  });

  it("is line-anchored, NOT JS-aware: a pragma inside a template literal matches", () => {
    // Documented behaviour, identical to the existing @capability parser. It is
    // safe by construction: a pragma can only REQUEST a link, and every link is
    // resolved against the lockfile and intersected down to the consumer's
    // ceiling — so a smuggled pragma can make a mount FAIL, never reach further.
    const src = ["const doc = `", "// @uses smuggled acme.evil@1.0.0", "`;"].join("\n");
    expect(parseUses(src).uses).toEqual([
      { alias: "smuggled", package: "acme.evil", pin: "1.0.0", isolated: false },
    ]);
  });

  it("parses // @export names and the module's own capabilities", () => {
    expect(parseExports(STATS_SOURCE).exports).toEqual(["mean", "scale"]);
    expect(parseModulePragmas(HTTP_SOURCE).pragmas.capabilities).toEqual(["net.fetch"]);
  });
});

// ===========================================================================
// 2. Ceiling arithmetic
// ===========================================================================

describe("effective ceiling", () => {
  it("is the intersection, and reports what was narrowed away", () => {
    const e = intersectCeiling(["net.fetch", "bi.query"], {
      capabilities: ["bi.query", "storage"],
      tier: "restricted",
    });
    expect(e.capabilities).toEqual(["bi.query"]);
    expect(e.narrowed).toEqual(["net.fetch"]);
  });

  it("takes min() of the tiers", () => {
    expect(minTier("unlocked", "restricted")).toBe("restricted");
    expect(minTier("unlocked", "unlocked")).toBe("unlocked");
    expect(intersectCeiling([], { capabilities: [], tier: "restricted" }, "unlocked").tier).toBe(
      "restricted",
    );
  });

  it("chains transitively: a depth-2 dep cannot re-widen what its parent gave up", () => {
    const parent = intersectCeiling(["net.fetch", "bi.query"], {
      capabilities: ["bi.query"],
      tier: "restricted",
    });
    // The grandchild declares net.fetch. Chained against the PARENT's effective
    // set (not the root consumer's declaration) it still cannot get it.
    const child = chainCeiling(["net.fetch", "bi.query"], parent);
    expect(child.capabilities).toEqual(["bi.query"]);
    expect(child.narrowed).toEqual(["net.fetch"]);
  });

  it("gives consumers with equal effective ceilings the same dedup key", () => {
    const a = intersectCeiling(["bi.query"], { capabilities: ["bi.query", "storage"], tier: "restricted" });
    const b = intersectCeiling(["bi.query"], { capabilities: ["bi.query"], tier: "restricted" });
    const c = intersectCeiling(["bi.query"], { capabilities: [], tier: "restricted" });
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
  });
});

// ===========================================================================
// 3. Linking: the happy path
// ===========================================================================

describe("linking a declared library", () => {
  it("mounts the library and lets the consumer call a declared export", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });

    const consumer = await mountConsumer({
      id: "script-a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });

    await expect(consumer.imports.stats.mean([1, 2, 3])).resolves.toBe(2);
    await expect(consumer.imports.stats.scale([1, 2], 3)).resolves.toEqual([3, 6]);
  });

  it("errors clearly on a property the library did not // @export", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const consumer = await mountConsumer({
      id: "script-a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(() => consumer.imports.stats.median).toThrow(/does not export 'median'/);
  });

  it("errors clearly on an alias the script did not declare", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const consumer = await mountConsumer({
      id: "script-a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(() => consumer.imports.other).toThrow(/did not declare a library aliased 'other'/);
  });

  it("shares one realm between consumers at the same effective ceiling", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await mountConsumer({
      id: "b",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(listLibraryRealms()).toHaveLength(1);
    expect(listLibraryRealms()[0].consumers.sort()).toEqual(["a", "b"]);
  });

  it("gives a DIFFERENT realm to a consumer with a different effective ceiling", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    await mountConsumer({
      id: "with-net",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch"],
    });
    await mountConsumer({
      id: "without-net",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
    });
    expect(listLibraryRealms()).toHaveLength(2);
  });

  it("// @uses-isolated forces a private realm even at an identical ceiling", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "a",
      source: "// @uses-isolated stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await mountConsumer({
      id: "b",
      source: "// @uses-isolated stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(listLibraryRealms()).toHaveLength(2);
  });

  it("unmounts the realm when its last consumer releases", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const a = await mountConsumer({
      id: "a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const b = await mountConsumer({
      id: "b",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    a.release();
    expect(listLibraryRealms()).toHaveLength(1);
    b.release();
    expect(listLibraryRealms()).toHaveLength(0);
  });
});

// ===========================================================================
// 4. THE LOAD-BEARING TEST: a library cannot widen its consumer
// ===========================================================================

describe("a library can NEVER widen its consumer's ceiling", () => {
  it("mounts the library WITHOUT a capability the consumer did not declare", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });

    // The consumer declares NOTHING. The library declares net.fetch.
    await mountConsumer({
      id: "innocent",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
    });

    const realmSpec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.http"));
    expect(realmSpec).toBeDefined();
    expect(realmSpec!.declaredCapabilities).toEqual([]);
    expect(realmSpec!.provenance).toBe("distributed");
    expect(realmSpec!.packageName).toBe("acme.http");
  });

  it("and the BROKER denies the library's fetch with PermissionDenied naming net.fetch", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    await mountConsumer({
      id: "innocent",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
    });

    const realmId = listLibraryRealms()[0].scriptId;
    const realmHandle = realms.get(realmId)!.handle;
    // Even though the library declared net.fetch AND we pre-grant it, the R19
    // ceiling handed to buildHandleFromDefinition is the INTERSECTION — so the
    // call is denied before the grant check and is never JIT-promptable.
    realmHandle.grants.add?.("net.fetch" as never);
    await expect(
      brokerCall(realmHandle, "cap.fetch", ["https://evil.example/x", {}], async () => "leaked"),
    ).rejects.toMatchObject({
      name: "BrokerError",
      code: "PermissionDenied",
      capability: "net.fetch",
    });
  });

  it("but a consumer that DID declare net.fetch gets a library realm that has it", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    await mountConsumer({
      id: "declares-net",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch"],
    });
    const realmSpec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.http"));
    expect(realmSpec!.declaredCapabilities).toEqual(["net.fetch"]);
  });

  it("surfaces the narrowing instead of leaving a mystery runtime error", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    const link = await linkScript({
      scriptId: "innocent",
      scriptName: "innocent",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
      declaredCapabilities: [],
      accessLevel: "restricted",
    });
    expect(link.imports[0].narrowedCapabilities).toEqual(["net.fetch"]);
    expect(link.imports[0].effectiveCapabilities).toEqual([]);
  });

  it("caps a library realm's tier at the consumer's tier", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "restricted-consumer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
      tier: "restricted",
    });
    const spec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"));
    expect(spec!.accessLevel).toBe("restricted");
  });
});

// ===========================================================================
// 5. A non-importer cannot reach the library
// ===========================================================================

describe("a script that did not declare the import cannot call the library", () => {
  it("refuses a call without the host-issued token", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const realmSpec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"))!;
    const instanceId = realmSpec.instanceId as string;

    const intruder = buildHandleFromDefinition({
      id: "intruder",
      name: "intruder",
      objectType: "workbook",
      instanceId: "intruder",
      accessLevel: "restricted",
      declaredCapabilities: [],
    });
    await expect(
      callExposed(intruder, "workbook", instanceId, "__callImport", [
        "ff".repeat(16),
        "mean",
        [[1, 2, 3]],
      ]),
    ).rejects.toThrow(/Not authorized to call this library/);
  });

  it("cannot install its own token: __addToken is non-public and cross-origin", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const instanceId = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"))!
      .instanceId as string;

    const intruder = buildHandleFromDefinition({
      id: "intruder",
      name: "intruder",
      objectType: "workbook",
      instanceId: "intruder",
      accessLevel: "restricted",
      declaredCapabilities: [],
    });
    await expect(
      callExposed(intruder, "workbook", instanceId, "__addToken", ["ff".repeat(16)]),
    ).rejects.toBeInstanceOf(BrokerError);
  });

  it("revokes EVERY token a consumer holds, including a second alias for the same package", async () => {
    // Two aliases resolve to one realm. If the second issue overwrote the first
    // token instead of joining it, alias-1's credential would stay live in the
    // realm after release with nothing tracking it.
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const consumer = await mountConsumer({
      id: "twice",
      source:
        "// @uses one acme.stats@^1.2.4\n// @uses two acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await expect(consumer.imports.one.mean([2, 4])).resolves.toBe(3);
    await expect(consumer.imports.two.mean([2, 4])).resolves.toBe(3);
    expect(listLibraryRealms()).toHaveLength(1);

    consumer.release();
    expect(listLibraryRealms()).toHaveLength(0);
  });

  it("a released consumer's token stops working", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const a = await mountConsumer({
      id: "a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const b = await mountConsumer({
      id: "b",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await expect(a.imports.stats.mean([2, 4])).resolves.toBe(3);
    a.release();
    // b still holds the realm, so it is still mounted — but a's token is gone.
    await expect(b.imports.stats.mean([2, 4])).resolves.toBe(3);
    await expect(a.imports.stats.mean([2, 4])).rejects.toThrow(/Not authorized/);
  });
});

// ===========================================================================
// 6. Lockfile: pinning, drift, missing dependency, integrity
// ===========================================================================

describe("lockfile", () => {
  it("fails the mount when the declared library is not installed", async () => {
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "My Script",
        source: "// @uses stats acme.stats@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "unresolved-alias" });
  });

  it("names the missing package in the error", async () => {
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "My Script",
        source: "// @uses stats acme.stats@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/"acme\.stats" is not installed in this workbook/);
  });

  it("refuses to silently substitute a different pin", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      pin: "^1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "My Script",
        source: "// @uses stats acme.stats@^2.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "version-drift" });
  });

  it("binds the LOCKED version, not whatever a registry would resolve now", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const link = await linkScript({
      scriptId: "s",
      scriptName: "s",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
      declaredCapabilities: [],
      accessLevel: "restricted",
    });
    expect(link.imports[0].resolvedVersion).toBe("1.2.4");
    // Nothing consulted the registry during a mount.
    expect(invokeBackend).not.toHaveBeenCalledWith("library_resolve", expect.anything());
  });

  it("refuses a cached source that no longer matches its hash", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    // Tamper with the workbook outside Calcula.
    const lock = await loadLockfile();
    const hash = lock.libraries[0].modules[0].sourceHash;
    vfs.set(`.calcula/script-libs/${hash}.js`, STATS_SOURCE + "\n// evil");
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "integrity" });
  });

  it("stops the mount when consent for the library has lapsed", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    // Simulate an upstream source change that was never re-approved: the
    // lockfile + cache move, the consent record does not.
    const newSource = STATS_SOURCE + "\n// v2";
    const newHash = await sha256Hex(newSource);
    const lock = await loadLockfile();
    lock.libraries[0].modules[0].sourceHash = newHash;
    vfs.set(".calcula/script-deps.json", JSON.stringify(lock));
    vfs.set(`.calcula/script-libs/${newHash}.js`, newSource);

    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "consent-required" });
  });

  it("removing a package also drops the transitive nodes only it required", async () => {
    await installLibrary({
      pkg: "acme.fmt",
      version: "1.0.1",
      modules: [{ id: "fmt", source: STATS_SOURCE }],
      requiredBy: ["acme.stats"],
    });
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    expect((await loadLockfile()).libraries).toHaveLength(2);
    const left = await removeLockedLibrary("acme.stats");
    expect(left).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Generated code shape
// ===========================================================================

describe("generated sources", () => {
  it("routes ONLY declared exports and gates on the token", () => {
    const src = generateLibraryRealmSource([
      { id: "m", exports: ["mean"], source: STATS_SOURCE },
    ]);
    expect(src).toContain('context.expose("__callImport"');
    expect(src).toContain('{ public: true }');
    // The token installer is NON-public: only trusted host code can reach it.
    expect(src).toMatch(/__addToken[\s\S]*?\{ public: false \}/);
    expect(src).toContain('exports: ["mean"]');
  });

  it("emits the prelude as a SINGLE line so user line numbers do not shift", () => {
    const prelude = generatePrelude([
      { alias: "s", package: "acme.stats", instanceId: "__lib_x", token: "t".repeat(32), exports: ["mean"] },
    ]);
    expect(prelude.trimEnd().split("\n")).toHaveLength(1);
    expect(prelude.endsWith("\n")).toBe(true);
  });

  it("emits nothing at all for a script with no imports", () => {
    expect(generatePrelude([])).toBe("");
  });

  it("types the imports binding from the LOCKFILE, export by export", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const dts = await generateImportsTypings("// @uses stats acme.stats@^1.2.4\n");
    expect(dts).toContain("declare const imports");
    expect(dts).toContain("readonly stats: {");
    expect(dts).toContain("readonly mean: (...args: any[]) => Promise<any>;");
    expect(dts).toContain("readonly scale: (...args: any[]) => Promise<any>;");
    expect(dts).not.toContain("median");
  });

  it("types a NOT-INSTALLED alias as never, so the editor shows it before the mount does", async () => {
    const dts = await generateImportsTypings("// @uses missing acme.gone@^1.0.0\n");
    expect(dts).toContain("readonly missing: never;");
    expect(dts).toContain("NOT INSTALLED");
  });

  it("emits no typings for a script with no imports", async () => {
    expect(await generateImportsTypings("function setup(context) {}\n")).toBe("");
  });
});

// ===========================================================================
// 8. Malformed declarations fail the mount
// ===========================================================================

describe("malformed declarations", () => {
  it("throws LibraryLinkError('malformed') rather than ignoring the pragma", async () => {
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses s acme.stats@nope\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toBeInstanceOf(LibraryLinkError);
  });

  it("refuses a package whose modules export the same name twice", async () => {
    await installLibrary({
      pkg: "acme.dup",
      version: "1.0.0",
      modules: [
        { id: "a", source: STATS_SOURCE },
        { id: "b", source: STATS_SOURCE },
      ],
    });
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses d acme.dup@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/both export 'mean'/);
  });
});

// ===========================================================================
// 9. TRANSITIVE dependencies — a library's own `// @uses`
//
//    `resolveClosure` installs, consents and locks a whole dependency graph, so
//    the LINKER has to be able to run one. These tests pin the two things that
//    make a transitive link safe rather than merely working: the ceiling is
//    chained against the PARENT (never re-widened against the root consumer),
//    and the dependency realm is refcounted against the parent realm so it
//    cannot outlive it.
// ===========================================================================

/** A leaf library that wants BOTH capabilities. */
const LEAF_SOURCE = [
  "// @capability net.fetch",
  "// @capability bi.query",
  "// @export leafCall",
  "function library(context) {",
  "  return { leafCall: () => 'leaf' };",
  "}",
].join("\n");

/** A middle library that declares only bi.query and re-exports the leaf. */
const MIDDLE_SOURCE = [
  "// @capability bi.query",
  "// @uses leaf acme.leaf@^1.0.0",
  "// @export middleCall",
  "function library(context) {",
  "  return { middleCall: async () => await imports.leaf.leafCall() };",
  "}",
].join("\n");

describe("transitive library dependencies", () => {
  async function installChain(): Promise<void> {
    await installLibrary({
      pkg: "acme.leaf",
      version: "1.0.0",
      modules: [{ id: "leaf", source: LEAF_SOURCE }],
      requiredBy: ["acme.middle"],
    });
    await installLibrary({
      pkg: "acme.middle",
      version: "1.0.0",
      modules: [{ id: "middle", source: MIDDLE_SOURCE }],
      uses: [{ alias: "leaf", package: "acme.leaf", pin: "^1.0.0", isolated: false }],
    });
  }

  it("mounts the dependency realm and makes the chained call actually work", async () => {
    await installChain();
    const consumer = await mountConsumer({
      id: "c1",
      source: "// @uses mid acme.middle@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["bi.query"],
    });
    // The chained call crosses TWO realm boundaries: consumer -> middle -> leaf.
    await expect(consumer.imports.mid.middleCall()).resolves.toBe("leaf");

    const packages = listLibraryRealms().map((r) => r.package).sort();
    expect(packages).toEqual(["acme.leaf", "acme.middle"]);
    const middle = listLibraryRealms().find((r) => r.package === "acme.middle")!;
    expect(middle.dependencies).toEqual(["acme.leaf"]);
  });

  it("chains the ceiling against the PARENT, so a leaf cannot re-widen past the middle", async () => {
    await installChain();
    // The CONSUMER declares both. The MIDDLE declares only bi.query. The LEAF
    // declares both again — the classic laundering shape: if the leaf were
    // intersected against the ROOT it would get net.fetch back.
    await mountConsumer({
      id: "c1",
      source: "// @uses mid acme.middle@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch", "bi.query"],
    });
    const leaf = listLibraryRealms().find((r) => r.package === "acme.leaf")!;
    const middle = listLibraryRealms().find((r) => r.package === "acme.middle")!;
    expect(middle.capabilities).toEqual(["bi.query"]);
    expect(leaf.capabilities).toEqual(["bi.query"]);
    expect(leaf.capabilities).not.toContain("net.fetch");

    // And the mount spec the broker built its R19 ceiling from says the same.
    const leafSpec = mountSpecs.find((s) => String(s.packageName) === "acme.leaf")!;
    expect(leafSpec.declaredCapabilities).toEqual(["bi.query"]);
  });

  it("releases the dependency realm when the last consumer of its parent goes away", async () => {
    await installChain();
    const consumer = await mountConsumer({
      id: "c1",
      source: "// @uses mid acme.middle@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["bi.query"],
    });
    expect(listLibraryRealms()).toHaveLength(2);
    consumer.release();
    // Both realms are gone — the leaf is not left mounted with a live token.
    expect(listLibraryRealms()).toEqual([]);
    expect(hostUnmountScript).toHaveBeenCalledTimes(2);
  });

  it("refuses a hand-edited lockfile whose libraries import each other", async () => {
    await installLibrary({
      pkg: "acme.a",
      version: "1.0.0",
      modules: [
        {
          id: "a",
          source: "// @uses b acme.b@^1.0.0\n// @export ping\nfunction library() { return { ping: () => 1 }; }",
        },
      ],
      uses: [{ alias: "b", package: "acme.b", pin: "^1.0.0", isolated: false }],
    });
    await installLibrary({
      pkg: "acme.b",
      version: "1.0.0",
      modules: [
        {
          id: "b",
          source: "// @uses a acme.a@^1.0.0\n// @export pong\nfunction library() { return { pong: () => 1 }; }",
        },
      ],
      uses: [{ alias: "a", package: "acme.a", pin: "^1.0.0", isolated: false }],
    });
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses a acme.a@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/dependency cycle/);
    // Nothing half-mounted survives the refusal.
    expect(listLibraryRealms()).toEqual([]);
  });
});

// ===========================================================================
// 10. Realm sharing must not launder net.fetch ORIGINS
//
//     Origins are intersected with the consumer's exactly as capabilities are.
//     If the sharing key ignored them, the FIRST consumer to mount a realm
//     would fix the origin allowlist for every later sharer — and a consumer
//     that declared only b.example would reach a.example through it.
// ===========================================================================

const ORIGIN_SOURCE = [
  "// @capability net.fetch https://a.example",
  "// @capability net.fetch https://b.example",
  "// @export get",
  "function library(context) { return { get: () => 1 }; }",
].join("\n");

describe("net.fetch origin narrowing across shared realms", () => {
  beforeEach(async () => {
    await installLibrary({
      pkg: "acme.http2",
      version: "1.0.0",
      modules: [{ id: "http", source: ORIGIN_SOURCE }],
    });
  });

  async function link(scriptId: string, origins: string[]): Promise<void> {
    await linkScript({
      scriptId,
      scriptName: scriptId,
      source: "// @uses h acme.http2@^1.0.0\nfunction setup(context) {}\n",
      declaredCapabilities: ["net.fetch"] as never,
      declaredNetOrigins: origins,
      accessLevel: "restricted",
    });
  }

  it("gives two consumers with DIFFERENT declared origins two different realms", async () => {
    await link("c1", ["https://a.example"]);
    await link("c2", ["https://b.example"]);

    const byOrigin = listLibraryRealms().map((r) => r.netOrigins.join(","));
    expect(byOrigin.sort()).toEqual(["https://a.example", "https://b.example"]);
    // The second consumer did NOT inherit the first's realm (and its origin).
    expect(listLibraryRealms()).toHaveLength(2);
  });

  it("still shares ONE realm when the resolved origin sets are identical", async () => {
    await link("c1", ["https://a.example"]);
    await link("c2", ["https://a.example"]);
    expect(listLibraryRealms()).toHaveLength(1);
    expect(listLibraryRealms()[0].consumers.sort()).toEqual(["c1", "c2"]);
  });

  it("narrows to the intersection — an origin the consumer never declared is dropped", async () => {
    await link("c1", ["https://b.example", "https://evil.example"]);
    expect(listLibraryRealms()[0].netOrigins).toEqual(["https://b.example"]);
  });
});
