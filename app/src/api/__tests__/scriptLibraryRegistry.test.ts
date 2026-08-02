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

/**
 * The backend's TOFU pin store, modelled here because the PREVIEW-vs-INSTALL
 * split is a frontend contract as much as a Rust one: `planInstall` /
 * `checkUpdates` must call `library_resolve` WITHOUT `confirm`, and only
 * `applyInstall` may pass it. A fake that always answered "firstUse" (as this
 * one used to) could not tell the two apart, which is how the preview-pins bug
 * survived. The state machine below mirrors `verify_library_manifest` in
 * app/src-tauri/src/library_commands.rs.
 */
const pinStore = new Map<string, string>();

/** Stand-in for the signed artifact SHA-256: content-derived, so a source edit
 *  changes the artifact identity exactly as a real republish would. */
function fakeArtifactHash(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8);
}

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
    const confirm = args?.confirm === true;
    const requests = (args?.requests ?? []) as Array<{
      package: string;
      pin: string;
      expectedPublisherKey?: string;
      expectedVersion?: string;
    }>;
    // Pins are held until the WHOLE batch verifies, mirroring the backend's
    // "never partial success" contract for the trust store.
    const pending: Array<[string, string]> = [];
    const out = requests.map((r) => {
      const pkg = registry.get(r.package);
      if (!pkg) throw new Error(`unknown package '${r.package}'`);
      if (pkg.kind !== "library") throw new Error(`'${r.package}' is a '${pkg.kind}' package`);
      const version = pickVersion(pkg, r.pin);
      // Install-time expectations are enforced BEFORE anything is pinned, so a
      // registry that moved between review and approval cannot squat the pin.
      if (confirm && r.expectedVersion !== undefined && r.expectedVersion !== version) {
        throw new Error(
          `${r.package} changed between review and install: ${r.expectedVersion} was reviewed but the pin '${r.pin}' now resolves to ${version}`,
        );
      }
      if (
        confirm &&
        r.expectedPublisherKey !== undefined &&
        r.expectedPublisherKey !== pkg.publisherKey
      ) {
        throw new Error(
          `${r.package}@${version} changed between review and install: it was reviewed as published by ${r.expectedPublisherKey} but this version is signed by ${pkg.publisherKey}`,
        );
      }
      const pinned = pinStore.get(r.package);
      let trustStatus: string;
      if (pinned !== undefined && pinned !== pkg.publisherKey) {
        throw new Error(
          `${r.package}@${version}: Publisher key changed since first use: pinned ${pinned} but this version is signed by ${pkg.publisherKey}`,
        );
      } else if (pinned !== undefined) {
        trustStatus = "verified";
      } else if (confirm) {
        pending.push([r.package, pkg.publisherKey]);
        trustStatus = "firstUse";
      } else {
        trustStatus = "notInstalled";
      }
      return {
        package: r.package,
        resolvedVersion: version,
        pin: r.pin,
        description: pkg.description,
        author: pkg.author,
        publisherName: "Test Publisher",
        publisherKey: pkg.publisherKey,
        trustStatus,
        modules: pkg.versions[version].map((m) => ({
          id: m.id,
          name: m.name,
          description: null,
          source: m.source,
          artifactSha256: fakeArtifactHash(m.source),
        })),
      };
    });
    for (const [name, key] of pending) pinStore.set(name, key);
    return out;
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
  pinStore.clear();
  resolveCalls = 0;
  invokeBackend.mockClear();
});

/** Every `library_resolve` call the frontend made, with its `confirm` flag. */
function resolveCallsWithConfirm(): Array<boolean> {
  return invokeBackend.mock.calls
    .filter((c) => c[0] === "library_resolve")
    .map((c) => (c[1] as { confirm?: boolean } | undefined)?.confirm === true);
}

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
// A PREVIEW VERIFIES; ONLY AN INSTALL PINS
//
// `library_resolve` used to pin trust-on-first-use on EVERY call, so merely
// building an install plan (or checking for updates) created the TOFU pin a
// genuine publisher would later be measured against. Structurally the same bug
// `decide_extension_trust_for_scan` fixed for extension scanning; these tests
// pin the frontend half of the fix — which call passes `confirm`.
// ===========================================================================

describe("preview never pins; install does", () => {
  beforeEach(() => {
    registry.set("acme.stats", {
      kind: "library",
      description: "Statistics",
      author: "Acme",
      publisherKey: "aa".repeat(32),
      versions: { "1.2.4": [{ id: "stats", name: "Statistics", source: src("mean") }] },
    });
  });

  it("planInstall resolves WITHOUT confirm and writes no pin", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);

    expect(resolveCallsWithConfirm()).toEqual([false]);
    expect(pinStore.size).toBe(0);
    // First contact reads as its own non-trusting status, NOT as "verified"
    // (which would claim this machine had vouched for the publisher) and not as
    // "firstUse" (which would claim a pin now exists).
    expect(plan.nodes[0].trustStatus).toBe("notInstalled");
  });

  it("repeated previews never start pinning", async () => {
    await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(pinStore.size).toBe(0);
    expect(resolveCallsWithConfirm()).toEqual([false, false, false]);
  });

  it("applyInstall pins the publisher, and a later preview then reads verified", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    await applyInstall(plan);

    expect(pinStore.get("acme.stats")).toBe("aa".repeat(32));
    expect(resolveCallsWithConfirm()).toEqual([false, true]);

    const second = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(second.nodes[0].trustStatus).toBe("verified");
  });

  it("a squatter that was only PREVIEWED does not make the genuine publisher look hijacked", async () => {
    // THE ATTACK. An impostor occupies the name in a registry the user browses.
    // The user previews it and does not install. Later the genuine publisher
    // ships the real library. Under the old behaviour the preview had pinned the
    // impostor's key, so the real author resolved as "publisher changed".
    registry.get("acme.stats")!.publisherKey = "99".repeat(32); // squatter
    const squatted = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(squatted.nodes[0].trustStatus).toBe("notInstalled");
    expect(pinStore.size).toBe(0);

    // The genuine publisher takes over the name.
    registry.get("acme.stats")!.publisherKey = "aa".repeat(32);
    const genuine = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(genuine.nodes[0].trustStatus).toBe("notInstalled");
    expect(genuine.nodes[0].publisherKey).toBe("aa".repeat(32));

    // Installing the genuine one pins the GENUINE key...
    await applyInstall(genuine);
    expect(pinStore.get("acme.stats")).toBe("aa".repeat(32));

    // ...and NOW the squatter is the one who is refused.
    registry.get("acme.stats")!.publisherKey = "99".repeat(32);
    await expect(
      planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]),
    ).rejects.toThrow(/Publisher key changed/i);
  });

  it("a preview still REFUSES a key that contradicts an existing pin", async () => {
    // "Does not write the pin store" must not be confused with "does not check
    // it": once a publisher is pinned, a preview has to enforce the pin.
    await applyInstall(await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]));
    registry.get("acme.stats")!.publisherKey = "dd".repeat(32);
    await expect(
      planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]),
    ).rejects.toThrow(/Publisher key changed/i);
    expect(pinStore.get("acme.stats")).toBe("aa".repeat(32));
  });

  it("applyInstall refuses code that changed between review and approval", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);

    // Same version, same publisher — the publisher re-signed different module
    // bytes after the user saw the plan. Only the per-module artifact hash
    // catches this, because only the frontend knows which bytes were reviewed.
    registry.get("acme.stats")!.versions["1.2.4"][0].source = src("mean", "// @capability net.fetch");

    await expect(applyInstall(plan)).rejects.toThrow(/changed between review and install/);
    // NOTHING is consented, locked or cached: the code was not approved.
    expect(await loadConsents()).toEqual([]);
    expect((await loadLockfile()).libraries).toEqual([]);
    expect(vfs.size).toBe(0);
    // The publisher pin DOES stand, and honestly so: the user approved trusting
    // this publisher for this name, and the key that got pinned is the key they
    // were shown. What was refused is the code, not the identity.
    expect(pinStore.get("acme.stats")).toBe("aa".repeat(32));
  });

  it("applyInstall refuses — and pins NOTHING — when the publisher key changed between review and approval", async () => {
    // THE RACE THAT MUST NOT PIN. If the identity check happened after the
    // confirming call, the swapped-in key would already be pinned by the time
    // the mismatch was noticed, which is the squat this whole change prevents.
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    registry.get("acme.stats")!.publisherKey = "dd".repeat(32);

    await expect(applyInstall(plan)).rejects.toThrow(/changed between review and install/);
    expect(pinStore.size).toBe(0);
    expect(await loadConsents()).toEqual([]);
  });

  it("applyInstall refuses — and pins NOTHING — when a floating pin moved between review and approval", async () => {
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(plan.nodes[0].version).toBe("1.2.4");
    registry.get("acme.stats")!.versions["1.9.0"] = [
      { id: "stats", name: "Statistics", source: src("mean") },
    ];

    await expect(applyInstall(plan)).rejects.toThrow(/changed between review and install/);
    expect(pinStore.size).toBe(0);
    expect(await loadConsents()).toEqual([]);
  });

  it("applyInstall refuses when a module disappeared between review and approval", async () => {
    registry.get("acme.stats")!.versions["1.2.4"].push({
      id: "extra",
      name: "Extra",
      source: src("pad"),
    });
    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    registry.get("acme.stats")!.versions["1.2.4"].pop();

    await expect(applyInstall(plan)).rejects.toThrow(/changed between review and install/);
    expect(await loadConsents()).toEqual([]);
    expect((await loadLockfile()).libraries).toEqual([]);
  });

  it("pins every node of a closure, transitive ones included, in ONE confirmed call", async () => {
    registry.get("acme.stats")!.versions["1.2.4"][0].source = src(
      "mean",
      "// @uses fmt acme.format@^1.0.0",
    );
    registry.set("acme.format", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "cc".repeat(32),
      versions: { "1.0.1": [{ id: "fmt", name: "fmt", source: src("pad") }] },
    });

    const plan = await planInstall("C:/reg", [{ package: "acme.stats", pin: "^1.2.0" }]);
    expect(plan.nodes.every((n) => n.trustStatus === "notInstalled")).toBe(true);
    invokeBackend.mockClear();
    await applyInstall(plan);

    // One confirmed round trip covering the whole approved graph — a transitive
    // dependency must not be pinned by some other, unreviewed path.
    expect(resolveCallsWithConfirm()).toEqual([true]);
    expect(pinStore.get("acme.stats")).toBe("aa".repeat(32));
    expect(pinStore.get("acme.format")).toBe("cc".repeat(32));
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
    // The package was pinned by the install in this describe's beforeEach, so a
    // key change is REFUSED by the backend's TOFU gate — `checkUpdates` never
    // gets a resolved node to compare keys against, and the change surfaces as
    // the error it is. (`publisherKeyChanged` on the status object is therefore
    // only reachable if the backend ever starts returning a mismatching key
    // instead of erroring; it is kept as a belt-and-braces field.)
    registry.get("acme.stats")!.publisherKey = "dd".repeat(32);
    const [status] = await checkUpdates();
    expect(status.error).toMatch(/Publisher key changed/i);
    expect(status.available).toBeNull();
  });

  it("checks for updates WITHOUT pinning anything new", async () => {
    // An update check is a preview. If it pinned, merely looking for updates
    // would trust whoever currently occupies the package name.
    registry.set("acme.newcomer", {
      kind: "library",
      description: "",
      author: "",
      publisherKey: "ee".repeat(32),
      versions: { "1.0.0": [{ id: "n", name: "n", source: src("x") }] },
    });
    invokeBackend.mockClear();
    await checkUpdates();
    expect(resolveCallsWithConfirm()).not.toContain(true);
    expect(pinStore.has("acme.newcomer")).toBe(false);
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
