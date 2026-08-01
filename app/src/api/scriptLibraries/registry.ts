//! FILENAME: app/src/api/scriptLibraries/registry.ts
// PURPOSE: Registry-facing half of the script package manager: search a .calp
//          registry for library packages, and resolve a request into a
//          FLATTENED, cycle-checked dependency closure.
// CONTEXT: Search is a filter over the EXISTING `calp_browse_registry` listing
//          (registries are directories and the package count is small) — no new
//          backend command and no index. Resolution calls the single new command
//          `library_resolve`, which verifies signature + TOFU + per-artifact
//          SHA-256 and hands back module SOURCES; the transitive walk lives here
//          because the dependency edges are `// @uses` pragmas, and pragma
//          semantics must have exactly one implementation (usesPragma.ts).
// SECURITY: Nothing here mounts, writes, grants or consents. It returns what
//          WOULD be installed so the consent gate can show the whole closure —
//          §7's rule that transitive nodes are named, never hidden behind a
//          count. A cycle is a hard error naming the cycle rather than a silent
//          truncation, and both the node count and the depth are capped so a
//          hostile registry cannot make resolution unbounded.

import { invokeBackend } from "../backend";
import type { CapabilityId } from "../scriptHost/capabilityIds";
import { parseModulePragmas } from "./usesPragma";
import type {
  LibraryClosure,
  LibraryClosureNode,
  LibraryRequest,
  LibraryUseDeclaration,
  ResolvedLibrary,
} from "./types";
import { LibraryLinkError } from "./types";

/** Upper bounds on a resolution. A registry is untrusted input. */
const MAX_CLOSURE_NODES = 64;
const MAX_DEPTH = 8;

/** A registry listing entry (mirrors the Rust `PackageInfo` of calp_commands). */
export interface RegistryPackageInfo {
  name: string;
  description: string;
  kind: string;
  author: string;
  versions: Array<{ version: string; publishedAt: string; publishedBy: string }>;
}

/** The manifest `kind` that marks a package as an importable script library. */
export const LIBRARY_PACKAGE_KIND = "library";

/**
 * List the LIBRARY packages of a registry, optionally filtered by a free-text
 * query over name / description / author.
 *
 * The registry is not a trust signal: presence here means "published", not
 * "reviewed". Callers must not imply curation in the UI.
 */
export async function searchLibraries(
  registryLocation: string,
  query = "",
): Promise<RegistryPackageInfo[]> {
  const all = await invokeBackend<RegistryPackageInfo[]>("calp_browse_registry", {
    registryPath: registryLocation,
  });
  const q = query.trim().toLowerCase();
  return all
    .filter((p) => p.kind === LIBRARY_PACKAGE_KIND)
    .filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q) ||
        (p.author || "").toLowerCase().includes(q),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve + verify a batch of packages (one backend round trip). */
function resolveBatch(
  registryLocation: string,
  requests: LibraryRequest[],
): Promise<ResolvedLibrary[]> {
  return invokeBackend<ResolvedLibrary[]>("library_resolve", {
    registryPath: registryLocation,
    requests,
  });
}

/** Build a closure node from a verified package: parse every module's pragmas. */
function toNode(
  library: ResolvedLibrary,
  requiredBy: string[],
): { node: LibraryClosureNode; errors: string[] } {
  const pragmas: Record<string, ReturnType<typeof parseModulePragmas>["pragmas"]> = {};
  const capabilities = new Set<CapabilityId>();
  const netOrigins = new Set<string>();
  const uses: LibraryUseDeclaration[] = [];
  const errors: string[] = [];
  for (const mod of library.modules) {
    const parsed = parseModulePragmas(mod.source);
    pragmas[mod.id] = parsed.pragmas;
    for (const e of parsed.errors) errors.push(`${library.package}/${mod.id}: ${e}`);
    for (const c of parsed.pragmas.capabilities) capabilities.add(c);
    for (const o of parsed.pragmas.netOrigins) netOrigins.add(o);
    for (const u of parsed.pragmas.uses) {
      if (!uses.some((x) => x.package === u.package && x.pin === u.pin)) uses.push(u);
    }
    if (parsed.pragmas.exports.length === 0) {
      errors.push(
        `${library.package}/${mod.id}: the module declares no // @export names, so nothing in it can be called.`,
      );
    }
  }
  return {
    node: {
      library,
      pragmas,
      declaredCapabilities: [...capabilities].sort(),
      declaredNetOrigins: [...netOrigins].sort(),
      requiredBy,
      uses,
    },
    errors,
  };
}

/**
 * Resolve `roots` (and everything they transitively `// @uses`) into a flattened
 * closure, dependencies first.
 *
 * A dependency CYCLE is a hard error naming the cycle. A node reached at two
 * different pins is also an error: silently picking one would make a workbook's
 * behaviour depend on resolution order, which is precisely the class of
 * surprise the lockfile exists to eliminate.
 */
export async function resolveClosure(
  registryLocation: string,
  roots: LibraryRequest[],
): Promise<LibraryClosure> {
  const resolved = new Map<string, LibraryClosureNode>();
  const pinOf = new Map<string, string>();
  const order: string[] = [];
  const errors: string[] = [];

  let frontier: Array<{ request: LibraryRequest; requiredBy: string; path: string[] }> = roots.map(
    (r) => ({ request: r, requiredBy: "", path: [] }),
  );

  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth > MAX_DEPTH) {
      throw new LibraryLinkError(
        "cycle",
        `Library dependencies nest more than ${MAX_DEPTH} levels deep; refusing to resolve further.`,
      );
    }

    // Cycle check BEFORE the round trip: a package that appears in its own
    // dependency path can never be resolved, and saying so beats timing out.
    const batch: LibraryRequest[] = [];
    const requirers = new Map<string, string[]>();
    for (const item of frontier) {
      const { package: pkg, pin } = item.request;
      if (item.path.includes(pkg)) {
        throw new LibraryLinkError(
          "cycle",
          `Library dependency cycle: ${[...item.path, pkg].join(" -> ")}.`,
        );
      }
      const priorPin = pinOf.get(pkg);
      if (priorPin !== undefined && priorPin !== pin) {
        throw new LibraryLinkError(
          "version-drift",
          `"${pkg}" is required at two different pins (${priorPin} and ${pin}). Align the pins before installing.`,
        );
      }
      const already = resolved.get(pkg);
      if (already) {
        if (item.requiredBy && !already.requiredBy.includes(item.requiredBy)) {
          already.requiredBy.push(item.requiredBy);
        }
        continue;
      }
      pinOf.set(pkg, pin);
      const list = requirers.get(pkg);
      if (list) {
        if (item.requiredBy && !list.includes(item.requiredBy)) list.push(item.requiredBy);
      } else {
        requirers.set(pkg, item.requiredBy ? [item.requiredBy] : []);
        batch.push({ package: pkg, pin });
      }
    }

    if (batch.length === 0) break;
    if (resolved.size + batch.length > MAX_CLOSURE_NODES) {
      throw new LibraryLinkError(
        "cycle",
        `The dependency closure exceeds ${MAX_CLOSURE_NODES} packages; refusing to resolve further.`,
      );
    }

    const libraries = await resolveBatch(registryLocation, batch);
    const nextFrontier: typeof frontier = [];
    for (const library of libraries) {
      const { node, errors: nodeErrors } = toNode(library, requirers.get(library.package) ?? []);
      errors.push(...nodeErrors);
      resolved.set(library.package, node);
      order.push(library.package);
      const parentPath = frontier.find((f) => f.request.package === library.package)?.path ?? [];
      for (const use of node.uses) {
        nextFrontier.push({
          request: { package: use.package, pin: use.pin },
          requiredBy: library.package,
          path: [...parentPath, library.package],
        });
      }
    }
    frontier = nextFrontier;
  }

  if (errors.length > 0) {
    throw new LibraryLinkError("malformed", errors.join("\n"));
  }

  // Dependencies before dependents: `order` is breadth-first from the roots, so
  // reversing it puts leaves first, which is the order consent + mount want.
  const nodes = order
    .slice()
    .reverse()
    .map((name) => resolved.get(name)!)
    .filter(Boolean);

  return { registry: registryLocation, nodes, roots: roots.map((r) => r.package) };
}
