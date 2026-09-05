//! FILENAME: app/src/api/scriptHost/__tests__/distributedMountApplicationConsent.test.ts
// PURPOSE: The mount boundary asks a question a MOUNT can answer.
//
// CONTEXT: The boundary itself was right — `mountWorker` cannot be called
//          without a `MountAdmission`, and the only producer of one runs the
//          consent gate. The QUESTION it asked was wrong.
//
//          `check_distributed_module_consent` resolves ownership by EXACT SOURCE
//          EQUALITY against stored MODULE records, and returns "allow" the moment
//          none matches:
//
//              if owners.is_empty() { return None; }   // an ad-hoc/editor run
//
//          Five of the six mount routes COMPOSE their realm source, so they match
//          no stored record and that gate answered ALLOW every single time:
//
//              chartMarkScripts.ts        a chart mark from an application
//              chartTransformScripts.ts   a chart transform from an application
//              customFunctions.ts         the UDF realm (prelude + merged bodies)
//              scriptLibraries/linker.ts  a shared-library realm
//              scriptableObjects.ts       an object script behind its prelude
//
//          (writebackValidators.ts is a SIXTH such route, and `rg` does not see
//          it: that file carries deliberate NUL separators in template literals,
//          so ripgrep treats it as binary and skips it. A census built on a text
//          search would have reported five routes and been wrong.)
//
//          All of them stamp `provenance: "distributed"` correctly, so the origin
//          was never the problem. The gate now asks about the APPLICATION —
//          "has this workbook approved code from `packageName`?" — which a
//          composed realm can be judged on, and it asks it ALONGSIDE the module
//          question, never instead of it: a stored module a `.calp` shipped is
//          still refused unless the consent record names that module.
//
//          THE DOUBLE BELOW ANSWERS ONLY YES/NO. Whether the workbook's consent
//          file actually approves an application — the key namespaces, the
//          artifact hash, the empty-record case — is decided in Rust and unit
//          tested there (`distributed_mount_refusal`,
//          app/src-tauri/src/scripting/commands.rs). What is under test here is
//          that every mount route reaches that decision, hands it the
//          application, and does not create a realm when it says no.
//
//          THE RENDERER'S OWN GATES ARE DELIBERATELY SATISFIED. `isConsentCurrent`
//          is mocked TRUE throughout, i.e. every surface's own consent check says
//          "go ahead". The renderer is assumed hostile, so the boundary has to
//          refuse anyway — and that is exactly what these tests assert.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

// ---------------------------------------------------------------------------
// The backend door. `check_distributed_mount_consent` is the ONE gate; every
// other command answers null.
//
// NOTE what is NOT here: `check_distributed_module_consent`. If the host reverts
// to asking the module question, this double returns null (= allow) for it and
// every refusal below turns green-to-red, which is the point.
// ---------------------------------------------------------------------------

interface MountGateCall {
  packageName: string;
  source: string;
  /** The consent-store namespace the mount asked to be judged under. */
  surface: string | null;
  /** What the mount's own surface recorded for it — id + the approved source. */
  artifacts: Array<{ id: string; source: string }> | null;
}

const gate = {
  /** Applications whose code this workbook approves. */
  approved: new Set<string>(),
  /** The gate could not be reached at all (IPC down, command missing). */
  unreachable: null as string | null,
  /** The MODULE half refused (a stored module the record does not name). */
  moduleRefusal: null as string | null,
};

const mountGateCalls: MountGateCall[] = [];

const invokeBackend = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  if (cmd !== "check_distributed_mount_consent") return null;
  const a = (args ?? {}) as Partial<MountGateCall>;
  mountGateCalls.push({
    packageName: a.packageName ?? "",
    source: a.source ?? "",
    surface: a.surface ?? null,
    artifacts: a.artifacts ?? null,
  });
  if (gate.unreachable) throw new Error(gate.unreachable);
  if (gate.moduleRefusal) {
    throw new Error(
      `DISTRIBUTED_SCRIPT_NOT_CONSENTED: '${gate.moduleRefusal}' arrived in the package ` +
        "'Acme Finance Pack' and you have not approved that package's code, so it will not run.",
    );
  }
  if (!gate.approved.has(a.packageName ?? "")) {
    throw new Error(
      `DISTRIBUTED_SCRIPT_NOT_CONSENTED: this code arrived in the application ` +
        `'${a.packageName}' and you have not approved that application's code, so it will not run.`,
    );
  }
  return null;
});

vi.mock("../../backend", () => ({
  invokeBackend: (cmd: string, args?: unknown) => invokeBackend(cmd, args),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
  readVirtualFile: vi.fn().mockRejectedValue(new Error("no backend in test")),
  createVirtualFile: vi.fn().mockResolvedValue(undefined),
}));

/** The routes' own Tauri door (get_script / save_script) — never reached here. */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

/** The OTHER mount gate: the global Script Security setting. Always allows, so
 *  a refusal below can only have come from the consent gate. */
const assertMountAllowed = vi.fn(async (_name: string) => undefined);
vi.mock("../mountGate", () => ({
  assertMountAllowed: (name: string) => assertMountAllowed(name),
}));

/** The Script Security gate on ObjectScriptManager.mountScript — same reasoning.
 *  PARTIAL: only the ask is replaced, so the module's real error types and
 *  everything else keep their identity. */
vi.mock("../../scriptSecurity", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureScriptsAllowed: vi.fn().mockResolvedValue(true),
}));

vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
  applyConsentedCapabilities: vi.fn().mockResolvedValue(undefined),
}));

// EVERY SURFACE'S OWN CONSENT CHECK SAYS YES. The renderer is assumed hostile;
// the boundary must refuse regardless of what the renderer decided.
vi.mock("../../distributedConsent", () => ({
  loadConsents: vi.fn().mockResolvedValue([]),
  isConsentCurrent: vi.fn().mockResolvedValue(true),
  recordConsent: vi.fn().mockResolvedValue(undefined),
  getChangedScripts: vi.fn().mockResolvedValue([]),
  sha256Hex: vi.fn().mockResolvedValue("0".repeat(64)),
}));

/** The library barrel (ObjectScriptManager + customFunctions link through it).
 *  The REAL linker is imported directly, by path, and is exercised for real. */
vi.mock("../../scriptLibraries", () => ({
  linkScript: vi.fn().mockResolvedValue({ prelude: "", imports: [], release: () => undefined }),
  resetScriptLibraryRealms: vi.fn(),
}));

/** UDF registration — not what is under test. */
vi.mock("../../formulaFunctions", () => ({
  registerFunction: vi.fn(() => () => undefined),
  UDF_ERROR_KEY: "__calculaError",
}));

/** The one-off runner reads the undo state before it mounts. */
vi.mock("../../lib", () => ({
  getUndoState: vi.fn().mockResolvedValue({ transactionOpen: false }),
  cancelUndoTransaction: vi.fn().mockResolvedValue(undefined),
}));

// The workbook's MODULE store, for the one-off runner's origin resolution.
interface StoredModule {
  id: string;
  name: string;
  source: string;
  sourcePackage?: string | null;
}
const moduleStore = new Map<string, StoredModule>();
vi.mock("../../workbookScripts", () => ({
  listWorkbookScripts: async () => [...moduleStore.values()].map((m) => ({ id: m.id, name: m.name })),
  getWorkbookScript: async (id: string) => {
    const found = moduleStore.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
}));

// The workbook lockfile, for the shared-library linker.
const LIB_MODULE_SOURCE = [
  "// @export mean",
  "function library(context) { return { mean: (v) => v.length }; }",
].join("\n");
const lockedLibraries: Array<Record<string, unknown>> = [];
vi.mock("../../scriptLibraries/lockfile", () => ({
  loadLockfile: async () => ({ version: 1, libraries: lockedLibraries }),
  findLocked: (lockfile: { libraries: Array<{ package: string }> }, name: string) =>
    lockfile.libraries.find((l) => l.package === name),
  readLockedSource: async () => LIB_MODULE_SOURCE,
}));

// ---------------------------------------------------------------------------
// A minimal realm that answers the mount handshake and nothing else.
// ---------------------------------------------------------------------------
class FakeWorker {
  static instances: FakeWorker[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") this.emit({ t: "mounted", ok: true });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

const PUBLISHER = "Acme Finance Pack";

type HostModule = typeof import("../host");
let host: HostModule;

/** Import a route module in the CURRENT registry generation, so it links against
 *  the same `host` instance the assertions read. */
async function route<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

beforeEach(async () => {
  FakeWorker.instances = [];
  FakeWorker.last = null;
  mountGateCalls.length = 0;
  moduleStore.clear();
  lockedLibraries.length = 0;
  gate.approved.clear();
  gate.unreachable = null;
  gate.moduleRefusal = null;
  invokeBackend.mockClear();
  assertMountAllowed.mockClear().mockResolvedValue(undefined);
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  vi.resetModules();
  host = await import("../host");
});

afterEach(() => {
  host.hostResetAll();
  globalScope.Worker = originalWorker;
});

/** Every application the gate was asked about, in order. */
function applicationsAsked(): string[] {
  return mountGateCalls.map((c) => c.packageName);
}

// ===========================================================================
// THE QUESTION ITSELF
// ===========================================================================

describe("the mount gate asks about the APPLICATION, not just the source", () => {
  const definition = {
    id: "run-vendor-close",
    name: "Vendor close",
    objectType: "workbook",
    instanceId: null,
    source: "function setup(context) { return 1; }",
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: PUBLISHER,
    apiVersion: "1.0.0",
  };

  it("sends the application name, so a COMPOSED realm source can still be judged", async () => {
    gate.approved.add(PUBLISHER);

    await host.hostMountScript({ ...definition });

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].packageName).toBe(PUBLISHER);
    expect(mountGateCalls[0].source).toBe(definition.source);
  });

  it("REFUSES an application this workbook never approved, and creates no realm", async () => {
    await expect(host.hostMountScript({ ...definition })).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    expect(FakeWorker.instances).toHaveLength(0);
    expect(host.hostIsMounted("run-vendor-close")).toBe(false);
  });

  it("still refuses when the MODULE half says no, even for an approved application", async () => {
    // The two questions are asked together and either one refuses. A macro a
    // `.calp` shipped is not covered by the approval of that application's
    // OBJECT scripts, and replacing the module question with the application
    // question would have let it through.
    gate.approved.add(PUBLISHER);
    gate.moduleRefusal = "macro-vendor-close";

    await expect(host.hostMountScript({ ...definition })).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("refuses when the gate cannot be reached at all", async () => {
    gate.approved.add(PUBLISHER);
    gate.unreachable = "IPC channel closed";

    await expect(host.hostMountScript({ ...definition })).rejects.toThrow(
      /could not be established[\s\S]*IPC channel closed/,
    );
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("asks about the placeholder — never about nothing — when the name is missing", async () => {
    // A distributed stamp with no package name must not become "ask about the
    // empty string", which a record could conceivably match.
    const unnamed = { ...definition };
    delete (unnamed as Record<string, unknown>).packageName;

    await expect(host.hostMountScript(unnamed)).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    expect(applicationsAsked()).toEqual(["(unknown package)"]);
  });

  it("does not ask about the user's own code", async () => {
    await host.hostMountScript({
      ...definition,
      id: "local-script",
      provenance: "local",
      packageName: undefined,
    });

    expect(mountGateCalls).toEqual([]);
    expect(host.hostIsMounted("local-script")).toBe(true);
  });

  it("holds NAMED artifacts to the gate too, without hashing them in the renderer", async () => {
    gate.approved.add(PUBLISHER);

    await host.hostMountScript({
      ...definition,
      source: "imports = {};\nfunction setup(context) { return 1; }",
      consentSurface: "object-script",
      consentArtifacts: [{ id: "obj-1", source: "function setup(context) { return 1; }" }],
    });

    // The artifact travels as the PRE-PRELUDE source: hashing is Rust's job, and
    // the composed realm source would hash to something no record has seen.
    expect(mountGateCalls[0].artifacts).toEqual([
      { id: "obj-1", source: "function setup(context) { return 1; }" },
    ]);
    expect(mountGateCalls[0].source).not.toBe(mountGateCalls[0].artifacts?.[0].source);
  });

  it("passes the surface and the artifacts THROUGH — it fills in neither", async () => {
    // A definition that names no surface asks with `null`, and the Rust gate
    // refuses that. The host must not guess a surface for it, and must not
    // substitute an empty list for absent artifacts: both would be a second
    // copy of a decision that belongs to the owning surface and to Rust.
    gate.approved.add(PUBLISHER);

    await host.hostMountScript({ ...definition });

    expect(mountGateCalls[0].surface).toBeNull();
    expect(mountGateCalls[0].artifacts).toBeNull();
  });

  it("an admission granted for one artifact cannot be re-presented for another", async () => {
    gate.approved.add(PUBLISHER);
    await host.hostMountScript({
      ...definition,
      consentSurface: "object-script",
      consentArtifacts: [{ id: "obj-1", source: definition.source }],
    });
    expect(host.hostIsMounted("run-vendor-close")).toBe(true);

    // A remount that swapped the artifact under the standing admission would be a
    // consent bypass wearing a proof; the remount paths re-present, never re-ask.
    await expect(
      host.hostStartDebugSession("run-vendor-close", [1]),
    ).resolves.toBeTruthy();
    expect(mountGateCalls).toHaveLength(1);
  });
});

// ===========================================================================
// ROUTE 1 — a chart MARK that arrived in an application
// ===========================================================================

describe("route: chart mark scripts", () => {
  const MARK_LIB = { marks: [{ markId: "sandbox:donut", label: "Donut", layoutFamily: "radial" as const, body: "ctx.fillRect(0,0,1,1);" }] };

  async function install(): Promise<void> {
    const mod = await route<typeof import("../../chartMarkScripts")>("../../chartMarkScripts");
    await mod.installChartMarkLibrary(MARK_LIB, () => undefined, { sourcePackage: PUBLISHER });
  }

  it("an UNCONSENTED application cannot mount a mark realm", async () => {
    await expect(install()).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED/);
    expect(applicationsAsked()).toEqual([PUBLISHER]);
    expect(FakeWorker.instances).toHaveLength(0);
    const mod = await route<typeof import("../../chartMarkScripts")>("../../chartMarkScripts");
    expect(mod.chartMarksInstalled()).toBe(false);
  });

  it("a refused install REJECTS instead of hanging on its own queue slot", async () => {
    // The gate made a LATENT deadlock the ordinary path. `doInstall` is the
    // install queue's current slot, and its rollback used to `await
    // queuedTeardown()` — a promise chained onto that very slot, which cannot
    // settle until the rollback returns. A refusal that hangs is worse than one
    // that fires: the caller never learns why nothing happened.
    const outcome = await Promise.race([
      install().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);

    expect(outcome).toBe("rejected");
  });

  it("a CONSENTED application's mark mounts and registers", async () => {
    gate.approved.add(PUBLISHER);
    let registered = "";
    const mod = await route<typeof import("../../chartMarkScripts")>("../../chartMarkScripts");
    await mod.installChartMarkLibrary(MARK_LIB, (_id, markId) => { registered = markId; }, {
      sourcePackage: PUBLISHER,
    });

    expect(registered).toBe("sandbox:donut");
    expect(mod.chartMarksInstalled()).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    mod.uninstallChartMarks();
  });

  it("names its SURFACE and the artifact its own gate recorded", async () => {
    // The Charts gate records `{ id: CHART_MARKS_SCRIPT_ID, source:
    // markLibraryConsentSource(lib) }` under `chart-marks:<package>`. The mount
    // presents exactly that — the same former, over the same library — so Rust
    // judges it under the chart-marks key and at that hash, not under "any key
    // this application's name can be spelled with".
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../chartMarkScripts")>("../../chartMarkScripts");
    await mod.installChartMarkLibrary(MARK_LIB, () => undefined, { sourcePackage: PUBLISHER });

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].surface).toBe("chart-marks");
    expect(mountGateCalls[0].artifacts).toEqual([
      { id: mod.CHART_MARKS_SCRIPT_ID, source: mod.markLibraryConsentSource(MARK_LIB) },
    ]);
    // ...and it is the consent identity, not the generated worker source.
    expect(mountGateCalls[0].artifacts?.[0].source).not.toBe(mountGateCalls[0].source);
    mod.uninstallChartMarks();
  });
});

// ===========================================================================
// ROUTE 2 — a chart TRANSFORM that arrived in an application
// ===========================================================================

describe("route: chart transform scripts", () => {
  const LIB = { transforms: [{ type: "sandbox:topn", label: "Top N", body: "return data;" }] };

  it("an UNCONSENTED application cannot mount the transform realm", async () => {
    const mod = await route<typeof import("../../chartTransformScripts")>(
      "../../chartTransformScripts",
    );
    await expect(
      mod.installChartTransformLibrary(LIB, { sourcePackage: PUBLISHER }),
    ).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED/);
    expect(applicationsAsked()).toEqual([PUBLISHER]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("a refused install REJECTS instead of hanging on its own queue slot", async () => {
    // Same latent deadlock as the mark library's; same fix.
    const mod = await route<typeof import("../../chartTransformScripts")>(
      "../../chartTransformScripts",
    );
    const outcome = await Promise.race([
      mod.installChartTransformLibrary(LIB, { sourcePackage: PUBLISHER }).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);

    expect(outcome).toBe("rejected");
  });

  it("a CONSENTED application's transforms mount", async () => {
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../chartTransformScripts")>(
      "../../chartTransformScripts",
    );
    await mod.installChartTransformLibrary(LIB, { sourcePackage: PUBLISHER });

    expect(FakeWorker.instances).toHaveLength(1);
    expect(host.hostIsMounted(mod.CHART_TRANSFORMS_SCRIPT_ID)).toBe(true);
    mod.uninstallChartTransforms();
  });

  it("names its SURFACE and the artifact its own gate recorded", async () => {
    // `{ id: CHART_TRANSFORMS_SCRIPT_ID, source: transformLibraryConsentSource(lib) }`
    // under `chart-transforms:<package>` — capability pragmas included, so a
    // widening re-hashes.
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../chartTransformScripts")>(
      "../../chartTransformScripts",
    );
    const withCaps = { ...LIB, capabilities: ["bi.query" as const] };
    await mod.installChartTransformLibrary(withCaps, { sourcePackage: PUBLISHER });

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].surface).toBe("chart-transforms");
    expect(mountGateCalls[0].artifacts).toEqual([
      { id: mod.CHART_TRANSFORMS_SCRIPT_ID, source: mod.transformLibraryConsentSource(withCaps) },
    ]);
    expect(mountGateCalls[0].artifacts?.[0].source).toContain("// @capability bi.query");
    mod.uninstallChartTransforms();
  });
});

// ===========================================================================
// ROUTE 3 — the UDF library realm (prelude + publisher-merged bodies)
// ===========================================================================

describe("route: custom function (UDF) realms", () => {
  const LIB = {
    functions: [{ name: "VENDORFEE", params: ["x"], body: "return x * 2;", sourcePackage: PUBLISHER }],
  };

  it("an UNCONSENTED application's functions cannot mount a realm", async () => {
    const mod = await route<typeof import("../../customFunctions")>("../../customFunctions");
    await expect(mod.installCustomFunctions(LIB)).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    // The realm source is COMPOSED — this is exactly the shape the old
    // source-equality question waved through.
    expect(applicationsAsked()).toEqual([PUBLISHER]);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(mod.customFunctionsInstalled()).toBe(false);
  });

  it("a CONSENTED application's functions mount and calculate", async () => {
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../customFunctions")>("../../customFunctions");
    await mod.installCustomFunctions(LIB);

    expect(mod.customFunctionsInstalled()).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    mod.uninstallCustomFunctions();
  });

  it("names its SURFACE and the artifact its own gate recorded", async () => {
    // `grantCustomFunctionConsent` records `{ id: CUSTOM_FUNCTIONS_SCRIPT_ID,
    // source: customFunctionConsentSource(fns, caps) }` under
    // `custom-functions:<package>`. The realm's mount presents that same pair —
    // the RECORD's reserved id, not the per-package broker id it mounts under.
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../customFunctions")>("../../customFunctions");
    const withCaps = { ...LIB, capabilities: ["bi.query" as const] };
    await mod.installCustomFunctions(withCaps);

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].surface).toBe("custom-functions");
    expect(mountGateCalls[0].artifacts).toEqual([
      {
        id: mod.CUSTOM_FUNCTIONS_SCRIPT_ID,
        source: mod.customFunctionConsentSource(withCaps.functions, ["bi.query"]),
      },
    ]);
    mod.uninstallCustomFunctions();
  });

  it("the artifact is over EVERY function the package stamped, as the record was", async () => {
    // The gate groups every function stamped with the package — a blank body
    // included — and the record is written over that grouping. The realm plan
    // drops blanks from what MOUNTS, but the artifact it names must still be
    // the record's string, or a consented package would be refused at the hash.
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../customFunctions")>("../../customFunctions");
    const withBlank = {
      functions: [
        ...LIB.functions,
        { name: "DRAFT", params: [], body: "   ", sourcePackage: PUBLISHER },
      ],
    };
    await mod.installCustomFunctions(withBlank);

    expect(mountGateCalls[0].artifacts).toEqual([
      {
        id: mod.CUSTOM_FUNCTIONS_SCRIPT_ID,
        source: mod.customFunctionConsentSource(withBlank.functions, []),
      },
    ]);
    // The blank is in the consent identity and NOT in the realm.
    expect(mountGateCalls[0].artifacts?.[0].source).toContain('"name":"DRAFT"');
    expect(mountGateCalls[0].source).not.toContain("DRAFT");
    mod.uninstallCustomFunctions();
  });
});

// ===========================================================================
// ROUTE 4 — a shared script LIBRARY realm
// ===========================================================================

describe("route: shared script library realms", () => {
  const CONSUMER_SOURCE = [
    "// @uses stats acme.stats@^1.0.0",
    "function setup(context) { return 1; }",
  ].join("\n");

  function lockLibrary(): void {
    lockedLibraries.push({
      package: "acme.stats",
      pin: "^1.0.0",
      resolved: "1.0.0",
      registry: "C:/workspace",
      publisherKey: "aa".repeat(32),
      publisherName: "Acme",
      modules: [{ id: "m1", name: "m1", sourceHash: "h1", artifactSha256: "h1", exports: ["mean"], capabilities: [], netOrigins: [] }],
      uses: [],
      requiredBy: [],
      installedAt: "2026-01-01T00:00:00Z",
    });
  }

  it("an UNCONSENTED library cannot mount its realm", async () => {
    lockLibrary();
    const mod = await route<typeof import("../../scriptLibraries/linker")>(
      "../../scriptLibraries/linker",
    );
    await expect(
      mod.linkScript({
        scriptId: "consumer",
        scriptName: "Consumer",
        source: CONSUMER_SOURCE,
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED/);
    // The realm's source is the generated prelude plus the merged modules, so the
    // library package is the only thing the gate can be asked about.
    expect(applicationsAsked()).toEqual(["acme.stats"]);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(mod.listLibraryRealms()).toHaveLength(0);
  });

  it("a CONSENTED library links, and its consumer gets an import binding", async () => {
    gate.approved.add("acme.stats");
    lockLibrary();
    const mod = await route<typeof import("../../scriptLibraries/linker")>(
      "../../scriptLibraries/linker",
    );
    const link = await mod.linkScript({
      scriptId: "consumer",
      scriptName: "Consumer",
      source: CONSUMER_SOURCE,
      declaredCapabilities: [],
      accessLevel: "restricted",
    });

    expect(link.imports.map((i) => i.alias)).toEqual(["stats"]);
    expect(mod.listLibraryRealms()).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
    link.release();
  });

  it("names the `lib` SURFACE and one artifact PER MODULE it merged", async () => {
    // `applyInstall` records `node.modules.map(m => ({ id, source }))` under
    // `lib:<package>`; the realm merges exactly those module sources and names
    // each one, so Rust requires every module to be granted — under the LIBRARY
    // key, which is the separation consentKey.ts promises.
    gate.approved.add("acme.stats");
    lockLibrary();
    const mod = await route<typeof import("../../scriptLibraries/linker")>(
      "../../scriptLibraries/linker",
    );
    const link = await mod.linkScript({
      scriptId: "consumer",
      scriptName: "Consumer",
      source: CONSUMER_SOURCE,
      declaredCapabilities: [],
      accessLevel: "restricted",
    });

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].surface).toBe("lib");
    expect(mountGateCalls[0].artifacts).toEqual([{ id: "m1", source: LIB_MODULE_SOURCE }]);
    // The realm source is prelude + wrapped modules; the artifact is the module.
    expect(mountGateCalls[0].source).not.toBe(LIB_MODULE_SOURCE);
    link.release();
  });
});

// ===========================================================================
// ROUTE 5 — a standing OBJECT SCRIPT mount (the one that can name its artifact)
// ===========================================================================

describe("route: standing object-script mounts", () => {
  const SCRIPT = {
    id: "obj-vendor",
    name: "Vendor panel",
    objectType: "workbook" as const,
    instanceId: null,
    source: "function setup(context) { return 1; }",
    accessLevel: "restricted" as const,
    provenance: "distributed",
    packageName: PUBLISHER,
  };

  async function manager(): Promise<typeof import("../../scriptableObjects")> {
    return route<typeof import("../../scriptableObjects")>("../../scriptableObjects");
  }

  it("an UNCONSENTED application's object script cannot mount", async () => {
    const mod = await manager();
    mod.ObjectScriptManager.registerScript(SCRIPT as never);

    await expect(mod.ObjectScriptManager.mountScript(SCRIPT.id)).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    expect(applicationsAsked()).toEqual([PUBLISHER]);
    expect(mod.ObjectScriptManager.isScriptMounted(SCRIPT.id)).toBe(false);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("names the ARTIFACT the consent record lists — the id and the pre-prelude source", async () => {
    gate.approved.add(PUBLISHER);
    const mod = await manager();
    mod.ObjectScriptManager.registerScript(SCRIPT as never);

    await mod.ObjectScriptManager.mountScript(SCRIPT.id);

    expect(mountGateCalls[0].surface).toBe("object-script");
    expect(mountGateCalls[0].artifacts).toEqual([{ id: SCRIPT.id, source: SCRIPT.source }]);
    expect(mod.ObjectScriptManager.isScriptMounted(SCRIPT.id)).toBe(true);
    mod.ObjectScriptManager.unmountScript(SCRIPT.id);
  });

  it("a local object script mounts without being asked about at all", async () => {
    const mod = await manager();
    mod.ObjectScriptManager.registerScript({
      ...SCRIPT,
      id: "obj-mine",
      provenance: "local",
      packageName: undefined,
    } as never);

    await mod.ObjectScriptManager.mountScript("obj-mine");

    expect(mountGateCalls).toEqual([]);
    expect(mod.ObjectScriptManager.isScriptMounted("obj-mine")).toBe(true);
    mod.ObjectScriptManager.unmountScript("obj-mine");
  });
});

// ===========================================================================
// ROUTE 6 — an advisory WRITEBACK VALIDATOR realm
// (the route `rg` cannot see: NUL separators make that file "binary")
// ===========================================================================

describe("route: writeback validator realms", () => {
  const DESCRIPTOR = {
    regionId: "region-1",
    packageName: PUBLISHER,
    packageVersion: "2.1.0",
    name: "positiveAmount",
    source: "(value) => (value > 0 ? null : 'must be positive')",
    sourceHash: "0".repeat(64),
    // The surface's OWN gate already said yes. The boundary asks anyway.
    consented: true,
  };

  it("an UNCONSENTED application cannot mount its validator, consented flag or not", async () => {
    const mod = await route<typeof import("../../writebackValidators")>(
      "../../writebackValidators",
    );
    await expect(mod.mountWritebackValidator(DESCRIPTOR)).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    expect(applicationsAsked()).toEqual([PUBLISHER]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("a CONSENTED application's validator mounts", async () => {
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../writebackValidators")>(
      "../../writebackValidators",
    );
    await mod.mountWritebackValidator(DESCRIPTOR);

    expect(FakeWorker.instances).toHaveLength(1);
    mod.unmountWritebackValidators();
  });

  it("names the writeback-validators SURFACE and the validator's own record entry", async () => {
    // `approveWritebackValidators` records `{ id: writebackValidatorScriptId(name),
    // source }` under `<package>::writeback-validators`; the mount presents that
    // pair, so the advisory realm is held to the exact body the authoritative
    // submit gate already checks.
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../writebackValidators")>(
      "../../writebackValidators",
    );
    await mod.mountWritebackValidator(DESCRIPTOR);

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].surface).toBe("writeback-validators");
    expect(mountGateCalls[0].artifacts).toEqual([
      { id: mod.writebackValidatorScriptId(DESCRIPTOR.name), source: DESCRIPTOR.source },
    ]);
    // The realm source wraps the body; the artifact IS the body.
    expect(mountGateCalls[0].source).toContain(DESCRIPTOR.source);
    expect(mountGateCalls[0].source).not.toBe(DESCRIPTOR.source);
    mod.unmountWritebackValidators();
  });
});

// ===========================================================================
// ROUTE 7 — the one-off runner (a stored MODULE, where BOTH questions bite)
// ===========================================================================

describe("route: the one-off object-script runner", () => {
  const MACRO_SOURCE = "function setup(context) { return context.api; }";

  beforeEach(() => {
    moduleStore.set("macro-vendor-close", {
      id: "macro-vendor-close",
      name: "Vendor close",
      source: MACRO_SOURCE,
      sourcePackage: PUBLISHER,
    });
  });

  it("an UNCONSENTED application's macro does not run", async () => {
    const mod = await route<typeof import("../../objectScriptRunner")>(
      "../../objectScriptRunner",
    );
    await expect(
      mod.runObjectScriptOnce({
        name: "Vendor close",
        source: MACRO_SOURCE,
        scriptId: "macro-vendor-close",
      }),
    ).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED/);
    expect(applicationsAsked()).toEqual([PUBLISHER]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("an approved APPLICATION does not admit a macro the record never named", async () => {
    // The module question keeps its own teeth: approving an application's object
    // scripts is not approving every module it shipped.
    gate.approved.add(PUBLISHER);
    gate.moduleRefusal = "macro-vendor-close";
    const mod = await route<typeof import("../../objectScriptRunner")>(
      "../../objectScriptRunner",
    );
    await expect(
      mod.runObjectScriptOnce({
        name: "Vendor close",
        source: MACRO_SOURCE,
        scriptId: "macro-vendor-close",
      }),
    ).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED/);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("a fully consented macro runs", async () => {
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../objectScriptRunner")>(
      "../../objectScriptRunner",
    );
    await mod.runObjectScriptOnce({
      name: "Vendor close",
      source: MACRO_SOURCE,
      scriptId: "macro-vendor-close",
      accessLevel: "restricted",
    });

    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("names the object-script SURFACE and the stored module as its artifact", async () => {
    // A module a `.calp` shipped is recorded under the BARE application key
    // alongside its object scripts (one grant covers both). The run names the
    // record's id and the source ABOUT TO RUN, so an edited publisher macro is
    // refused at the hash instead of admitted on the application floor.
    gate.approved.add(PUBLISHER);
    const mod = await route<typeof import("../../objectScriptRunner")>(
      "../../objectScriptRunner",
    );
    await mod.runObjectScriptOnce({
      name: "Vendor close",
      source: MACRO_SOURCE,
      scriptId: "macro-vendor-close",
    });

    expect(mountGateCalls).toHaveLength(1);
    expect(mountGateCalls[0].surface).toBe("object-script");
    expect(mountGateCalls[0].artifacts).toEqual([{ id: "macro-vendor-close", source: MACRO_SOURCE }]);

    // Edited in the textarea: the identity still says publisher, and the
    // artifact carries the EDITED text — which is what the gate must hash.
    mountGateCalls.length = 0;
    const edited = `${MACRO_SOURCE}\n// tweaked locally`;
    await mod.runObjectScriptOnce({
      name: "Vendor close",
      source: edited,
      scriptId: "macro-vendor-close",
    });
    expect(mountGateCalls[0].artifacts).toEqual([{ id: "macro-vendor-close", source: edited }]);

    // Resolved by CONTENT (no id given): the artifact is the record it matched.
    mountGateCalls.length = 0;
    await mod.runObjectScriptOnce({ name: "Vendor close", source: MACRO_SOURCE });
    expect(mountGateCalls[0].artifacts).toEqual([{ id: "macro-vendor-close", source: MACRO_SOURCE }]);
  });

  it("a local run names the surface and no artifact, and is never asked", async () => {
    const mod = await route<typeof import("../../objectScriptRunner")>(
      "../../objectScriptRunner",
    );
    await mod.runObjectScriptOnce({ name: "Mine", source: "function setup() {}" });
    expect(mountGateCalls).toEqual([]);
  });
});
