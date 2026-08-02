//! FILENAME: app/src/api/scriptLibraries/install.ts
// PURPOSE: Install / update / remove for script libraries — the consent gate and
//          the lockfile writer.
// CONTEXT: `planInstall` resolves and verifies a closure and returns it for
//          review; NOTHING is written or mounted until `applyInstall` runs, and
//          `applyInstall` refuses unless the caller passes the plan it showed.
// SECURITY:
//   * ONE DECISION, WHOLE CLOSURE. Approving a package approves the exact
//     resolved graph. Transitive nodes are named individually in the plan (never
//     "and 7 more" — that is how supply-chain attacks get approved), and any
//     later change to any node re-prompts with a diff.
//   * CONSENT IS PER WORKBOOK, keyed `lib:<package>` in
//     `.calcula/script-consent.json`, so a library trusted in one workbook is
//     not silently trusted in another, and a report package of the same name can
//     never satisfy a library's consent check.
//   * THE PLAN'S CAPABILITY LINES ARE THE LIBRARY'S OWN DECLARED SET, derived
//     from the verified SOURCE pragmas — not from a manifest field. What a given
//     script actually gets is that set intersected with the SCRIPT's own
//     declaration (ceiling.ts), which is narrower or equal; the UI must say so
//     rather than implying the library gets what it asked for.
//   * NO AUTO-UPDATE. `checkUpdates` reports; applying is an explicit action
//     that re-runs the consent gate. A silent version bump that changes executed
//     code is the same failure mode as a silent source swap.
//   * ONLY `applyInstall` PINS A PUBLISHER. `planInstall` and `checkUpdates`
//     resolve through the preview path, which verifies against an existing TOFU
//     pin but never creates one; `applyInstall` calls `resolveForInstall` once
//     the user has approved, and refuses if what the registry serves at that
//     moment differs in ANY byte from what the plan showed. So the key that gets
//     pinned is the key the user was shown, and a preview can never squat the
//     identity a genuine publisher will later be measured against.

import { sha256Hex, loadConsents, recordConsent, getChangedScripts } from "../distributedConsent";
import type { CapabilityGrant, ChangedScript } from "../distributedConsent";
import type { CapabilityId } from "../scriptHost/capabilityIds";
import { consentKeyFor } from "./consentKey";
import { commitLockedLibraries, loadLockfile, removeLockedLibrary } from "./lockfile";
import { resolveClosure, resolveForInstall } from "./registry";
import { parseModulePragmas } from "./usesPragma";
import type {
  LibraryClosure,
  LibraryRequest,
  LibraryUpdateStatus,
  LockedLibrary,
  LockedModule,
} from "./types";
import { LibraryLinkError } from "./types";

/** One node of an install plan, as shown to the user. */
export interface InstallPlanNode {
  package: string;
  version: string;
  pin: string;
  description: string;
  publisherName: string;
  publisherKey: string;
  /**
   * As reported by the PREVIEW resolve, so it is one of:
   *   "notInstalled" — authentic, but this machine has never agreed to trust
   *                    this publisher for this package name. THE NORMAL STATE
   *                    OF A PACKAGE THE USER IS ABOUT TO INSTALL, and the only
   *                    first-contact answer a preview may give.
   *   "verified"     — matches the key already pinned for this name.
   * Never "unsigned" (an unsigned package cannot be resolved at all — the
   * backend refuses before returning any source) and never "firstUse", which
   * only `applyInstall` can produce because only it creates a pin.
   *
   * UI MUST NOT collapse this to a two-way "firstUse or verified" test:
   * "notInstalled" is NOT verified, and presenting it as such tells the user
   * their machine vouched for a publisher it has never seen.
   */
  trustStatus: string;
  /** True when this node was pulled in by another package rather than requested. */
  transitive: boolean;
  requiredBy: string[];
  /** The library's OWN declared ceiling (source pragmas). A consuming script
   *  gets this INTERSECTED with its own declaration. */
  declaredCapabilities: CapabilityId[];
  exports: string[];
  modules: Array<{
    id: string;
    name: string;
    source: string;
    /** SHA-256 of the SOURCE (consent-store identity). */
    sourceHash: string;
    /** SHA-256 of the signed registry ARTIFACT (registry identity). */
    artifactSha256: string;
  }>;
  /** Modules whose source changed since this workbook last approved them. */
  changed: ChangedScript[];
  /** True when this exact node is already installed and consented — nothing to
   *  approve, shown for completeness. */
  alreadyConsented: boolean;
}

/** What the user is being asked to approve. */
export interface InstallPlan {
  registry: string;
  roots: string[];
  nodes: InstallPlanNode[];
  /** The union of every node's declared capabilities — the honest headline. */
  closureCapabilities: CapabilityId[];
  /** True when every node is already installed and consented (a no-op install). */
  upToDate: boolean;
}

async function hashModules(
  closure: LibraryClosure,
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const node of closure.nodes) {
    const perModule = new Map<string, string>();
    for (const mod of node.library.modules) {
      perModule.set(mod.id, await sha256Hex(mod.source));
    }
    out.set(node.library.package, perModule);
  }
  return out;
}

/**
 * Resolve `requests` (and everything they transitively `// @uses`) and build the
 * review plan. Verifies signatures + TOFU + per-artifact integrity (backend) and
 * derives every capability/export claim from the verified sources. Writes
 * nothing, mounts nothing, grants nothing.
 */
export async function planInstall(
  registryLocation: string,
  requests: LibraryRequest[],
): Promise<InstallPlan> {
  const closure = await resolveClosure(registryLocation, requests);
  const consents = await loadConsents();
  const hashes = await hashModules(closure);
  const closureCaps = new Set<CapabilityId>();
  const nodes: InstallPlanNode[] = [];

  for (const node of closure.nodes) {
    for (const cap of node.declaredCapabilities) closureCaps.add(cap);
    const key = consentKeyFor(node.library.package);
    const scripts = node.library.modules.map((m) => ({ id: m.id, source: m.source }));
    const changed = await getChangedScripts(consents, key, scripts);
    const record = consents.find((c) => c.packageName === key);
    let alreadyConsented = false;
    if (record) {
      alreadyConsented =
        changed.length === 0 &&
        scripts.every((s) =>
          record.scripts.some(
            (rs) => rs.id === s.id && rs.sourceHash === hashes.get(node.library.package)?.get(s.id),
          ),
        ) &&
        record.scripts.length === scripts.length;
    }
    nodes.push({
      package: node.library.package,
      version: node.library.resolvedVersion,
      pin: node.library.pin,
      description: node.library.description,
      publisherName: node.library.publisherName,
      publisherKey: node.library.publisherKey,
      trustStatus: node.library.trustStatus,
      transitive: !closure.roots.includes(node.library.package),
      requiredBy: node.requiredBy,
      declaredCapabilities: node.declaredCapabilities,
      exports: [
        ...new Set(node.library.modules.flatMap((m) => node.pragmas[m.id]?.exports ?? [])),
      ].sort(),
      modules: node.library.modules.map((m) => ({
        id: m.id,
        name: m.name,
        source: m.source,
        sourceHash: hashes.get(node.library.package)?.get(m.id) ?? "",
        artifactSha256: m.artifactSha256,
      })),
      changed,
      alreadyConsented,
    });
  }

  return {
    registry: closure.registry,
    roots: closure.roots,
    nodes,
    closureCapabilities: [...closureCaps].sort(),
    upToDate: nodes.every((n) => n.alreadyConsented),
  };
}

/**
 * THE PIN STEP. Re-resolve the approved plan with `confirm: true` — the one
 * call that may create a trust-on-first-use pin.
 *
 * WHY RE-RESOLVE RATHER THAN PIN FROM THE PLAN: the pin store is
 * Rust-authoritative and must never be written from renderer-supplied values.
 * `plan` is an ordinary JS object; a compromised renderer could hand
 * `applyInstall` a publisher key of its choosing. Re-resolving means the key
 * that gets pinned is a key the BACKEND just verified a signature against.
 *
 * WHY THE APPROVED IDENTITY IS SENT WITH THE REQUEST: re-resolving re-opens the
 * window between review and approval. `expectedPublisherKey` / `expectedVersion`
 * travel with each request so the BACKEND refuses before pinning if the registry
 * moved — comparing here, after the call, would mean a swapped publisher was
 * already pinned by the time we noticed.
 *
 * The per-module hash comparison below is the remaining layer the backend
 * cannot do: it does not know which module bytes the user reviewed. A publisher
 * re-signing the same version with different module bytes is refused here, and
 * nothing is consented, locked or cached. (Their key stays pinned — the user did
 * approve trusting that publisher; what is refused is the code.)
 */
async function pinApprovedPublishers(plan: InstallPlan): Promise<void> {
  if (plan.nodes.length === 0) return;
  const resolved = await resolveForInstall(
    plan.registry,
    plan.nodes.map((n) => ({
      package: n.package,
      pin: n.pin,
      expectedPublisherKey: n.publisherKey,
      expectedVersion: n.version,
    })),
  );

  const byPackage = new Map(resolved.map((r) => [r.package, r]));
  for (const node of plan.nodes) {
    const fresh = byPackage.get(node.package);
    if (!fresh) {
      throw new LibraryLinkError(
        "integrity",
        `"${node.package}" could no longer be resolved from ${plan.registry}. Nothing was installed.`,
      );
    }
    // Belt and braces: the backend already refused a version/key that differs
    // from the expectation, so reaching this means the backend agreed.
    if (fresh.resolvedVersion !== node.version || fresh.publisherKey !== node.publisherKey) {
      throw new LibraryLinkError(
        "integrity",
        `"${node.package}" changed between review and install (reviewed ${node.version} by ${node.publisherKey || "an unsigned publisher"}, registry now serves ${fresh.resolvedVersion} by ${fresh.publisherKey}). Nothing was installed — review it again.`,
      );
    }
    if (fresh.modules.length !== node.modules.length) {
      throw new LibraryLinkError(
        "integrity",
        `"${node.package}" changed between review and install: it now has ${fresh.modules.length} modules and ${node.modules.length} were reviewed. Nothing was installed — review it again.`,
      );
    }
    for (const mod of node.modules) {
      const freshModule = fresh.modules.find((m) => m.id === mod.id);
      if (!freshModule || freshModule.artifactSha256 !== mod.artifactSha256) {
        throw new LibraryLinkError(
          "integrity",
          `Module "${node.package}/${mod.id}" changed between review and install. Nothing was installed — review it again.`,
        );
      }
    }
  }
}

/**
 * Record consent for every node of the plan and write the lockfile + the
 * content-addressed source cache. The plan MUST be one `planInstall` produced —
 * consent is recorded against the sources it contains, which are the sources the
 * linker will later mount and re-hash.
 *
 * The publisher pin is created FIRST (`pinApprovedPublishers`): if the approved
 * closure can no longer be verified byte-for-byte, this throws before any
 * consent, lockfile entry or cached source exists.
 */
export async function applyInstall(plan: InstallPlan): Promise<void> {
  await pinApprovedPublishers(plan);
  const closure = derivePlanPragmas(plan);
  const sources = new Map<string, string>();
  const entries: LockedLibrary[] = [];
  const now = new Date().toISOString();

  for (const node of plan.nodes) {
    const grants: CapabilityGrant[] = node.declaredCapabilities.map((c) => ({ capability: c }));
    await recordConsent(
      consentKeyFor(node.package),
      node.modules.map((m) => ({ id: m.id, source: m.source })),
      grants,
    );
    const closureNode = closure.get(node.package);
    const modules: LockedModule[] = node.modules.map((m) => {
      const pragmas = closureNode?.pragmas[m.id];
      sources.set(m.sourceHash, m.source);
      return {
        id: m.id,
        name: m.name,
        sourceHash: m.sourceHash,
        artifactSha256: m.artifactSha256,
        exports: pragmas?.exports ?? [],
        capabilities: pragmas?.capabilities ?? [],
        netOrigins: pragmas?.netOrigins ?? [],
      };
    });
    entries.push({
      package: node.package,
      pin: node.pin,
      resolved: node.version,
      registry: plan.registry,
      publisherKey: node.publisherKey,
      publisherName: node.publisherName,
      modules,
      uses: closureNode?.uses ?? [],
      requiredBy: node.requiredBy,
      installedAt: now,
    });
  }

  await commitLockedLibraries(entries, sources);
}

interface PlanPragmas {
  pragmas: Record<string, { exports: string[]; capabilities: CapabilityId[]; netOrigins: string[] }>;
  uses: Array<{ alias: string; package: string; pin: string; isolated: boolean }>;
}

/** Re-derive the pragma/edge detail `applyInstall` needs, from the plan's own
 *  (already verified) sources — no second registry round trip, so what is locked
 *  is exactly what was reviewed. */
function derivePlanPragmas(plan: InstallPlan): Map<string, PlanPragmas> {
  const out = new Map<string, PlanPragmas>();
  for (const node of plan.nodes) {
    const pragmas: Record<string, { exports: string[]; capabilities: CapabilityId[]; netOrigins: string[] }> = {};
    const uses: Array<{ alias: string; package: string; pin: string; isolated: boolean }> = [];
    for (const mod of node.modules) {
      const parsed = parseModulePragmas(mod.source).pragmas;
      pragmas[mod.id] = {
        exports: parsed.exports,
        capabilities: parsed.capabilities,
        netOrigins: parsed.netOrigins,
      };
      for (const u of parsed.uses) {
        if (!uses.some((x) => x.alias === u.alias && x.package === u.package)) uses.push(u);
      }
    }
    out.set(node.package, { pragmas, uses });
  }
  return out;
}

/**
 * Re-resolve every locked library's PIN against its registry and report what an
 * update would change. Never applies anything.
 */
export async function checkUpdates(): Promise<LibraryUpdateStatus[]> {
  const lockfile = await loadLockfile();
  const consents = await loadConsents();
  const byRegistry = new Map<string, LockedLibrary[]>();
  for (const lib of lockfile.libraries) {
    const list = byRegistry.get(lib.registry);
    if (list) list.push(lib);
    else byRegistry.set(lib.registry, [lib]);
  }

  const out: LibraryUpdateStatus[] = [];
  for (const [registry, libs] of byRegistry) {
    for (const lib of libs) {
      const status: LibraryUpdateStatus = {
        package: lib.package,
        current: lib.resolved,
        available: null,
        error: null,
        sourceChanged: false,
        capabilityChanged: false,
        addedCapabilities: [],
        newDependencies: [],
        publisherKeyChanged: false,
      };
      try {
        const closure = await resolveClosure(registry, [{ package: lib.package, pin: lib.pin }]);
        const node = closure.nodes.find((n) => n.library.package === lib.package);
        if (!node) throw new Error("the registry no longer serves this package");
        status.available = node.library.resolvedVersion;
        status.publisherKeyChanged = node.library.publisherKey !== lib.publisherKey;

        const record = consents.find((c) => c.packageName === consentKeyFor(lib.package));
        for (const mod of node.library.modules) {
          const hash = await sha256Hex(mod.source);
          const prior = record?.scripts.find((s) => s.id === mod.id);
          if (!prior || prior.sourceHash !== hash) status.sourceChanged = true;
        }
        if (node.library.modules.length !== (record?.scripts.length ?? -1)) {
          status.sourceChanged = true;
        }

        const consented = new Set((record?.grantedCapabilities ?? []).map((g) => g.capability));
        const added = node.declaredCapabilities.filter((c) => !consented.has(c));
        status.addedCapabilities = added;
        status.capabilityChanged =
          added.length > 0 || node.declaredCapabilities.length !== consented.size;

        // A new transitive dependency is code this workbook never approved. It
        // must surface as loudly as a source change — "and one more package"
        // hidden inside an update is exactly the supply-chain shape the consent
        // gate exists to stop.
        const known = new Set(lockfile.libraries.map((l) => l.package));
        status.newDependencies = closure.nodes
          .map((n) => n.library.package)
          .filter((p) => !known.has(p));
      } catch (e) {
        status.error = e instanceof Error ? e.message : String(e);
      }
      out.push(status);
    }
  }
  return out;
}

/** Remove a library (and any transitive node it alone required). Scripts that
 *  still `// @uses` it will fail to mount with an "not installed" error — a
 *  loud break, never a silent unresolved import. */
export function uninstallLibrary(packageName: string): Promise<LockedLibrary[]> {
  return removeLockedLibrary(packageName);
}

/** The libraries this workbook is locked to (the manager UI's list). */
export async function listInstalledLibraries(): Promise<LockedLibrary[]> {
  return (await loadLockfile()).libraries;
}
