//! FILENAME: app/src/api/__tests__/scriptLibraryRegistry.test.ts
// PURPOSE: Registry-side contract tests for the script package manager: search,
//          transitive closure resolution, cycle + pin-conflict detection, the
//          consent plan, the lockfile write, and the update check.
// CONTEXT: docs/design/script-package-manager.md §4 + §7. The `library_resolve`
//          backend command is stubbed with a fake registry; what is under test
//          is everything the FRONTEND decides from its verified output — the
//          signature/TOFU/SHA-256 gate itself is Rust (library_commands.rs).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// ---------------------------------------------------------------------------
// Fake registry + workbook virtual filesystem
// ---------------------------------------------------------------------------

interface FakePackage {
  kind: string;
  description: string;
  author: string;
  publisherKey: string;
  versions: Record<string, Array<{ id: string; name: string; source: string }>>;
}

const registry = new Map<string, FakePackage>();
const vfs = new Map<string, string>();
let resolveCalls = 0;

function pickVersion(pkg: FakePackage, pin: string): string {
  const versions = Object.keys(pkg.versions).sort();
  if (pin === "latest" || pin === "*") return versions[versions.length - 1];
  if (pin.startsWith("^")) {
    const major = pin.slice(1).split(".")[0];
    const match = versions.filter((v) => v.split(".")[0] === major);
    if (match.length === 0) throw new Error(`no version of matches ${pin}`);
    return match[match.length - 1];
  }
  if (!versions.includes(pin)) throw new Error(`version ${pin} not found`);
  return pin;
}

const invokeBackend = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "calp_browse_registry") {
    return [...registry.entries()].map(([name, p]) => ({
      name,
      description: p.description,
      kind: p.kind,
      author: p.author,
      versions: Object.keys(p.versions)
        .sort()
        .map((v) => ({ version: v, publishedAt: "2026-01-01", publishedBy: "test" })),
    }));
  }
  if (cmd === "library_resolve") {
    resolveCalls++;
    const requests = (args?.requests ?? []) as Array<{ package: string; pin: string }>;
    return requests.map((r) => {
      const pkg = registry.get(r.package);
      if (!pkg) throw new Error(`unknown package '${r.package}'`);
      if (pkg.kind !== "library") throw new Error(`'${r.package}' is a '${pkg.kind}' package`);
      const version = pickVersion(pkg, r.pin);
      return {
        package: r.package,
        resolvedVersion: version,
        pin: r.pin,
        description: pkg.description,
        author: pkg.author,
        publisherName: "Test Publisher",
        publisherKey: pkg.publisherKey,
        trustStatus: "firstUse",
        modules: pkg.versions[version].map((m) => ({
          id: m.id,
          name: m.name,
          description: null,
          source: m.source,
          artifactSha256: "ab".repeat(32),
        })),
      };
    });
  }
  return undefined;
});

vi.mock("../backend", () => ({
  invokeBackend: (...a: unknown[]) => invokeBackend(...(a as [string, Record<string, unknown>])),
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

import {
  searchLibraries,
  resolveClosure,
  planInstall,
  applyInstall,
  checkUpdates,
  listInstalledLibraries,
  loadLockfile,
  consentKeyFor,
} from "../scriptLibraries";
import { loadConsents } from "../distributedConsent";

const src = (exportName: string, extra = ""): string =>
  [`// @export ${exportName}`, extra, "function library(context) {", `  return { ${exportName}: () => 1 };`, "}"]
    .filter(Boolean)
    .join("\n");

beforeEach(() => {
  registry.clear();
  vfs.clear();
  resolveCalls = 0;
  invokeBackend.mockClear();
});

// ===========================================================================
// Search
// ===========================================================================

describe("searchLibraries", () => {
  beforeEach(() => {
    registry.set("acme.stats", {
      kind: "library",
      description: "Statistics helpers",
      author: "Acme",
      publisherKey: "aa".repeat(32),
      versions: { "1.0.0": [{ id: "stats", name: "stats", source: src("mean") }] },
    });
    registry.set("acme.q4report", {
      kind: "report",
      description: "Quarterly numbers",
      author: "Acme",
      publisherKey: "bb".repeat(32),
      versions: { "1.0.0": [] },
    });
  });

  it("lists ONLY packages published with kind=library", async () => {
    const found = await searchLibraries("C:/reg");
    expect(found.map((p) => p.name)).toEqual(["acme.stats"]);
  });

  it("filters by name, description and author", async () => {
    expect((await searchLibraries("C:/reg", "statistics")).map((p) => p.name)).toEqual([
      "acme.stats",
    ]);
    expect(await searchLibraries("C:/reg", "nothing-matches")).toEqual([]);
  });
});

// ===========================================================================
// Closure resolution
// ===========================================================================

describe("resolveClosure", () => {
  it("flattens transitive dependencies, dependencies first", async () => {
    registry.set("acme.stats", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "aa".repeat(32),
      versions: {
        "1.2.4": [
          { id: "stats", name: "stats", source: src("mean", "// @uses fmt acme.format@^1.0.0") },
        ],
      },
    });
    registry.set("acme.format", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "cc".repeat(32),
      versions: { "1.0.1": [{ id: "fmt", name: "fmt", source: src("pad") }] },
    });

    const closure = await resolveClosure("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(closure.nodes.map((n) => n.library.package)).toEqual(["acme.format", "acme.stats"]);
    expect(closure.roots).toEqual(["acme.stats"]);
    expect(closure.nodes[0].requiredBy).toEqual(["acme.stats"]);
  });

  it("hard-errors on a dependency cycle, naming the cycle", async () => {
    registry.set("a.one", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "aa".repeat(32),
      versions: { "1.0.0": [{ id: "m", name: "m", source: src("x", "// @uses t a.two@^1.0.0") }] },
    });
    registry.set("a.two", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "bb".repeat(32),
      versions: { "1.0.0": [{ id: "m", name: "m", source: src("y", "// @uses o a.one@^1.0.0") }] },
    });
    await expect(resolveClosure("C:/reg", [{ package: "a.one", pin: "^1.0.0" }])).rejects.toThrow(
      /cycle: a\.one -> a\.two -> a\.one/,
    );
  });

  it("refuses a closure that needs one package at two different pins", async () => {
    registry.set("a.root", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "aa".repeat(32),
      versions: {
        "1.0.0": [
          { id: "m", name: "m", source: src("x", "// @uses l a.leaf@^1.0.0") },
          { id: "n", name: "n", source: src("y", "// @uses l2 a.leaf@2.0.0") },
        ],
      },
    });
    registry.set("a.leaf", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "bb".repeat(32),
      versions: { "1.0.0": [{ id: "m", name: "m", source: src("z") }] },
    });
    await expect(resolveClosure("C:/reg", [{ package: "a.root", pin: "^1.0.0" }])).rejects.toThrow(
      /two different pins/,
    );
  });

  it("refuses a module that declares no exports (nothing would be callable)", async () => {
    registry.set("a.empty", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "aa".repeat(32),
      versions: { "1.0.0": [{ id: "m", name: "m", source: "function library() { return {}; }" }] },
    });
    await expect(resolveClosure("C:/reg", [{ package: "a.empty", pin: "1.0.0" }])).rejects.toThrow(
      /declares no \/\/ @export names/,
    );
  });

  it("propagates the backend's refusal of a non-library package", async () => {
    registry.set("acme.report", {
      kind: "report",
      description: "",
      author: "",
      publisherKey: "aa".repeat(32),
      versions: { "1.0.0": [] },
    });
    await expect(
      resolveClosure("C:/reg", [{ package: "acme.report", pin: "1.0.0" }]),
    ).rejects.toThrow(/is a 'report' package/);
  });
});

// ===========================================================================
// Consent plan + install
// ===========================================================================

describe("install plan and lockfile", () => {
  beforeEach(() => {
    registry.set("acme.stats", {
      kind: "library",
      description: "Statistics helpers",
      author: "Acme",
      publisherKey: "aa".repeat(32),
      versions: {
        "1.2.4": [
          {
            id: "stats",
            name: "Statistics",
            source: src("mean", "// @capability bi.query\n// @uses fmt acme.format@^1.0.0"),
          },
        ],
      },
    });
    registry.set("acme.format", {
      kind: "library",
      description: "Formatting",
      author: "Acme",
      publisherKey: "cc".repeat(32),
      versions: { "1.0.1": [{ id: "fmt", name: "Format", source: src("pad") }] },
    });
  });

  it("NAMES every transitive node, never hides one behind a count", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(plan.nodes.map((n) => n.package).sort()).toEqual(["acme.format", "acme.stats"]);
    const transitive = plan.nodes.find((n) => n.package === "acme.format")!;
    expect(transitive.transitive).toBe(true);
    expect(transitive.requiredBy).toEqual(["acme.stats"]);
    expect(transitive.publisherName).toBe("Test Publisher");
  });

  it("reports the closure-wide capability set and each node's own declaration", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(plan.closureCapabilities).toEqual(["bi.query"]);
    expect(plan.nodes.find((n) => n.package === "acme.stats")!.declaredCapabilities).toEqual([
      "bi.query",
    ]);
    expect(plan.nodes.find((n) => n.package === "acme.format")!.declaredCapabilities).toEqual([]);
    expect(plan.nodes.find((n) => n.package === "acme.stats")!.exports).toEqual(["mean"]);
  });

  it("writes nothing until applyInstall runs", async () => {
    await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(vfs.size).toBe(0);
    expect(await loadConsents()).toEqual([]);
  });

  it("applyInstall records consent, locks the resolved version and caches the source", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    await applyInstall(plan);

    const lock = await loadLockfile();
    expect(lock.libraries.map((l) => l.package).sort()).toEqual(["acme.format", "acme.stats"]);
    const stats = lock.libraries.find((l) => l.package === "acme.stats")!;
    expect(stats.resolved).toBe("1.2.4");
    expect(stats.pin).toBe("^1.2.0");
    expect(stats.modules[0].exports).toEqual(["mean"]);
    expect(stats.modules[0].capabilities).toEqual(["bi.query"]);
    expect(stats.uses).toEqual([
      { alias: "fmt", package: "acme.format", pin: "^1.0.0", isolated: false },
    ]);
    // The source is cached content-addressed, so the workbook runs offline and
    // byte-identically.
    expect(vfs.has(`.calcula/script-libs/${stats.modules[0].sourceHash}.js`)).toBe(true);

    const consents = await loadConsents();
    expect(consents.map((c) => c.packageName).sort()).toEqual([
      consentKeyFor("acme.format"),
      consentKeyFor("acme.stats"),
    ]);
    expect(consents.find((c) => c.packageName === consentKeyFor("acme.stats"))!.grantedCapabilities)
      .toEqual([{ capability: "bi.query" }]);
  });

  it("keys consent as lib:<package> so a REPORT package of the same name cannot satisfy it", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    await applyInstall(plan);
    const consents = await loadConsents();
    expect(consents.some((c) => c.packageName === "acme.stats")).toBe(false);
    expect(consents.some((c) => c.packageName === "lib:acme.stats")).toBe(true);
  });

  it("marks an unchanged reinstall as already consented, and a source change as changed", async () => {
    await applyInstall(await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]));
    const second = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(second.upToDate).toBe(true);

    // Publisher rewrites the module body under the SAME version.
    registry.get("acme.stats")!.versions["1.2.4"][0].source = src(
      "mean",
      "// @capability bi.query\n// @capability net.fetch\n// @uses fmt acme.format@^1.0.0",
    );
    const third = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    const node = third.nodes.find((n) => n.package === "acme.stats")!;
    expect(third.upToDate).toBe(false);
    expect(node.changed).toHaveLength(1);
    expect(node.changed[0].oldSource).not.toBe(node.changed[0].newSource);
    expect(node.declaredCapabilities).toEqual(["bi.query", "net.fetch"]);
  });
});

// ===========================================================================
// Update check
// ===========================================================================

describe("checkUpdates", () => {
  beforeEach(async () => {
    registry.set("acme.stats", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "aa".repeat(32),
      versions: { "1.2.4": [{ id: "stats", name: "stats", source: src("mean") }] },
    });
    await applyInstall(await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]));
  });

  it("reports 'up to date' when the registry has not moved", async () => {
    const [status] = await checkUpdates();
    expect(status).toMatchObject({
      package: "acme.stats",
      current: "1.2.4",
      available: "1.2.4",
      sourceChanged: false,
      capabilityChanged: false,
      publisherKeyChanged: false,
      error: null,
    });
  });

  it("reports a newer compatible version, its source change and its new capabilities", async () => {
    registry.get("acme.stats")!.versions["1.3.0"] = [
      { id: "stats", name: "stats", source: src("mean", "// @capability net.fetch") },
    ];
    const [status] = await checkUpdates();
    expect(status.available).toBe("1.3.0");
    expect(status.sourceChanged).toBe(true);
    expect(status.capabilityChanged).toBe(true);
    expect(status.addedCapabilities).toEqual(["net.fetch"]);
  });

  it("names a NEW transitive dependency the update would pull in", async () => {
    registry.set("acme.format", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "cc".repeat(32),
      versions: { "1.0.0": [{ id: "fmt", name: "fmt", source: src("pad") }] },
    });
    registry.get("acme.stats")!.versions["1.3.0"] = [
      { id: "stats", name: "stats", source: src("mean", "// @uses fmt acme.format@^1.0.0") },
    ];
    const [status] = await checkUpdates();
    expect(status.available).toBe("1.3.0");
    expect(status.newDependencies).toEqual(["acme.format"]);
  });

  it("reports no new dependencies when the graph is unchanged", async () => {
    const [status] = await checkUpdates();
    expect(status.newDependencies).toEqual([]);
  });

  it("flags a publisher key change rather than accepting it silently", async () => {
    registry.get("acme.stats")!.publisherKey = "dd".repeat(32);
    const [status] = await checkUpdates();
    expect(status.publisherKeyChanged).toBe(true);
  });

  it("reports the failure instead of throwing when the package is gone", async () => {
    registry.delete("acme.stats");
    const [status] = await checkUpdates();
    expect(status.error).toMatch(/unknown package/);
    expect(status.available).toBeNull();
  });

  it("does NOT apply anything: the lockfile is untouched by a check", async () => {
    registry.get("acme.stats")!.versions["1.3.0"] = [
      { id: "stats", name: "stats", source: src("mean") },
    ];
    await checkUpdates();
    const installed = await listInstalledLibraries();
    expect(installed[0].resolved).toBe("1.2.4");
  });
});
