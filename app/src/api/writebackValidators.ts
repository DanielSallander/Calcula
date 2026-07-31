//! FILENAME: app/src/api/writebackValidators.ts
// PURPOSE: Publisher-shipped writeback validators — real, consented, sandboxed
//          CODE that ships inside the .calp package, replacing the old
//          name-only registry (the publisher named a validator and hoped the
//          subscriber's client already had a function by that name; nothing
//          ever registered one, so "custom validation" was metadata that never
//          ran anywhere).
//
// CONTEXT: A validator is a pure `(value, ctx) => true | string` — `true`
//          (or null/undefined/"") accepts, a non-empty string rejects with that
//          message. It is capability-free by construction: it gets a scalar and
//          a context object, and has nothing else to reach for.
//
//          WHERE IT ACTUALLY RUNS — two places, one source:
//
//          * AUTHORITATIVE: the Rust submit path (see the "Custom writeback
//            validators" section in app/src-tauri/src/calp_commands.rs) reads
//            the body out of the Ed25519 + TOFU verified version manifest and
//            runs it in the embedded QuickJS realm before any registry write.
//            THAT is the gate. It is not bypassable, because the backend never
//            accepts a verdict from its caller: a script holding
//            `distribution.writeback` calling `submitRegion` directly is judged
//            by exactly the same code as a human clicking Submit. There is
//            deliberately no "I already validated this" parameter to forge.
//
//          * ADVISORY: this module mounts the SAME source in the hardened
//            worker realm (restricted tier, distributed provenance, ZERO
//            declared capabilities — the identical machinery object scripts and
//            the sandboxed chart-transform/chart-mark libraries use) so the user
//            gets as-you-type feedback. Nothing depends on this run; if it is
//            blocked, faulted or simply not mounted yet, the submit gate still
//            holds.
//
//          CONSENT: publisher code that executes on a subscriber's machine goes
//          through the shared distributed-consent store (@api/distributedConsent
//          → `.calcula/script-consent.json` in the workbook), keyed by package
//          AND SHA-256 of the exact source. Editing the body changes the hash
//          and re-prompts. Validators are consented under
//          `<package>::writeback-validators` so granting them never clobbers —
//          or silently inherits — the object-script consent record for the same
//          package. Both key shapes are mirrored verbatim in Rust; the tests on
//          both sides pin them.
//
// ARCHITECTURE: @api module. Extensions drive it through the plumbing in
//               extensions/Distribution/lib/writebackValidatorSync.ts.

import { invoke } from "@tauri-apps/api/core";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
import { callExposedMethod } from "./scriptableObjects";
import { loadConsents, recordConsent, isConsentCurrent } from "./distributedConsent";

// ---------------------------------------------------------------------------
// Contract with the Rust gate (both key shapes are asserted in tests on both
// sides — changing one without the other silently un-consents every validator).
// ---------------------------------------------------------------------------

/** Consent-store package-key suffix reserved for writeback validators. */
export const WRITEBACK_VALIDATOR_CONSENT_SUFFIX = "::writeback-validators";

/** Consent-store package key for a package's writeback validators. */
export function writebackValidatorConsentKey(packageName: string): string {
  return `${packageName}${WRITEBACK_VALIDATOR_CONSENT_SUFFIX}`;
}

/** Consent-store script id for one validator. */
export function writebackValidatorScriptId(name: string): string {
  return `writeback-validator:${name}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context a validator receives about the value it is judging. */
export interface WritebackValidatorContext {
  valueType?: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  regionId: string;
  /** The package the validator was shipped by (absent on a local test run). */
  packageName?: string;
  /** The resolved package version (absent on a local test run). */
  packageVersion?: string;
  /** Zero-based cell coordinates, when judging a specific cell. */
  row?: number;
  col?: number;
}

/**
 * A validator function. Returning `true` (or null/undefined/"") accepts; a
 * non-empty string rejects with that message. Returning `false` rejects with a
 * default message; anything else is treated as a failure to judge, and FAILS
 * CLOSED at submit.
 *
 * The legacy `string | null` return is still honoured (null = accept), so a
 * validator written against the old advisory registry keeps working.
 */
export type WritebackValidatorFn = (
  value: unknown,
  ctx: WritebackValidatorContext
) => string | null | boolean | undefined;

/** A validator resolved from a package's verified manifest, ready to consent
 *  to and mount. Mirrors `OutboundValidator` in calp_commands.rs. */
export interface WritebackValidatorDescriptor {
  regionId: string;
  packageName: string;
  packageVersion: string;
  name: string;
  /** The exact JS function-expression source the backend will execute. */
  source: string;
  /** SHA-256 of `source` (computed backend-side over the verified manifest). */
  sourceHash: string;
  /** Whether this exact body is already approved to run on this machine. */
  consented: boolean;
}

/** What a region's validator situation is, as reported by the backend. */
export interface WritebackValidatorStatus {
  regionId: string;
  /** The validator that will judge submissions, when the region declares one. */
  validator: WritebackValidatorDescriptor | null;
  /** Set when the region declares a validator NAME but the package ships no
   *  BODY — submission will be refused until the publisher republishes. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Author-side catalogue (publishing)
// ---------------------------------------------------------------------------

interface Registration {
  name: string;
  label: string;
  validate: WritebackValidatorFn;
}

const authored = new Map<string, Registration>();

/**
 * Register a validator an AUTHOR can attach to a region they are designating.
 * The function's own source (`Function.prototype.toString`) is what gets
 * published in the package — the name alone is not enough for the subscriber to
 * run anything, which was the old design's whole failure.
 *
 * @returns Cleanup that unregisters the validator.
 */
export function registerWritebackValidator(
  name: string,
  label: string,
  validate: WritebackValidatorFn
): () => void {
  const id = name.trim();
  authored.set(id, { name: id, label, validate });
  return () => {
    const current = authored.get(id);
    if (current && current.validate === validate) authored.delete(id);
  };
}

/** List authored validators (for the publisher's designate-region picker). */
export function listWritebackValidators(): Array<{ name: string; label: string }> {
  return [...authored.values()].map((r) => ({ name: r.name, label: r.label }));
}

/**
 * The publishable SOURCE of an authored validator — what must be stamped into
 * the region schema's `customValidatorSource` so subscribers can actually run
 * it. Returns null for an unknown name.
 */
export function getWritebackValidatorSource(name: string): string | null {
  const reg = authored.get(name.trim());
  if (!reg) return null;
  return reg.validate.toString();
}

/**
 * The `extra` entries a designated region must carry for a custom validator:
 * the stable NAME plus the BODY. Both are required — a name without a body is
 * refused at submit time by design (see calp_commands.rs), so the authoring UI
 * must never write one without the other.
 */
export function writebackValidatorSchemaExtra(
  name: string
): { customValidator: string; customValidatorSource: string } | null {
  const source = getWritebackValidatorSource(name);
  if (!source) return null;
  return { customValidator: name.trim(), customValidatorSource: source };
}

// ---------------------------------------------------------------------------
// Subscriber side: discovery
// ---------------------------------------------------------------------------

/**
 * Ask the backend which validator will judge a region's submissions. The body
 * comes from the signature-verified manifest, so the source shown in the
 * consent prompt is byte-identical to the source the backend will execute.
 *
 * Resolves to `{ validator: null, error: null }` for regions with no validator
 * (the common case) and for regions the backend cannot resolve — never throws
 * into the caller's UI path.
 */
export async function fetchWritebackValidator(
  regionId: string
): Promise<WritebackValidatorStatus> {
  try {
    const preview = await invoke<{
      packageName: string;
      resolvedVersion: string;
      validator?: { name: string; source: string; sourceHash: string; consented: boolean };
      validatorError?: string;
    }>("calp_preview_region_submission", { regionId });
    if (preview.validatorError) {
      return { regionId, validator: null, error: preview.validatorError };
    }
    if (!preview.validator) return { regionId, validator: null, error: null };
    return {
      regionId,
      validator: {
        regionId,
        packageName: preview.packageName,
        packageVersion: preview.resolvedVersion,
        name: preview.validator.name,
        source: preview.validator.source,
        sourceHash: preview.validator.sourceHash,
        consented: preview.validator.consented,
      },
      error: null,
    };
  } catch (error) {
    return {
      regionId,
      validator: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Subscriber side: consent
// ---------------------------------------------------------------------------

/**
 * Whether every listed validator of ONE package is already approved at its
 * current source hash. Validators of different packages must be checked
 * separately (one consent record per package key).
 */
export async function writebackValidatorsConsented(
  packageName: string,
  descriptors: WritebackValidatorDescriptor[]
): Promise<boolean> {
  if (descriptors.length === 0) return true;
  const consents = await loadConsents();
  return isConsentCurrent(
    consents,
    writebackValidatorConsentKey(packageName),
    descriptors.map((d) => ({ id: writebackValidatorScriptId(d.name), source: d.source })),
  );
}

/**
 * Record the user's approval of a package's validators. MERGES with any
 * previously approved validators of the same package (recordConsent replaces a
 * whole record, so approving one validator must not un-approve its siblings).
 * Always grants ZERO capabilities: a validator is a pure predicate.
 */
export async function approveWritebackValidators(
  packageName: string,
  descriptors: WritebackValidatorDescriptor[]
): Promise<void> {
  const key = writebackValidatorConsentKey(packageName);
  const incoming = new Set(descriptors.map((d) => writebackValidatorScriptId(d.name)));
  const consents = await loadConsents();
  const existing = consents.find((c) => c.packageName === key);
  const kept = (existing?.scripts ?? [])
    .filter((s) => typeof s.source === "string" && !incoming.has(s.id))
    .map((s) => ({ id: s.id, source: s.source as string }));
  const added = descriptors.map((d) => ({
    id: writebackValidatorScriptId(d.name),
    source: d.source,
  }));
  await recordConsent(key, [...kept, ...added], []);
}

// ---------------------------------------------------------------------------
// Subscriber side: advisory execution in the hardened worker realm
// ---------------------------------------------------------------------------

const MOUNT_OBJECT_TYPE = "workbook";

function mountIds(packageName: string, name: string): { id: string; instanceId: string } {
  const instanceId = `__writeback_validator__:${packageName}:${name}`;
  return { id: `__calcula_writeback_validator__:${packageName}:${name}`, instanceId };
}

/**
 * The worker source: the publisher's function expression, wrapped so the worker
 * exposes ONE non-public `validate` method that normalizes every accepted
 * return shape to `null` (accept) or a message (reject). `public: false` keeps
 * cross-trust callers (another package's script) from driving it.
 *
 * Pure + exported for tests.
 */
export function generateValidatorWorkerSource(source: string): string {
  return (
    `function setup(context) {\n` +
    `  const __fn = (${source});\n` +
    `  context.expose("validate", async (value, ctx) => {\n` +
    `    if (typeof __fn !== "function") return "The validator did not evaluate to a function.";\n` +
    `    let r;\n` +
    `    try {\n` +
    `      r = await __fn(value, ctx);\n` +
    `    } catch (e) {\n` +
    `      return "the validator threw: " + String((e && e.message) || e);\n` +
    `    }\n` +
    `    if (r === true || r === null || r === undefined) return null;\n` +
    `    if (typeof r === "string") return r.trim() === "" ? null : r;\n` +
    `    if (r === false) return "Value rejected by the validator.";\n` +
    `    return "The validator gave no usable verdict.";\n` +
    `  }, { public: false });\n` +
    `}\n`
  );
}

interface Mounted {
  descriptor: WritebackValidatorDescriptor;
  instanceId: string;
  scriptId: string;
}

/** Mounted validators, keyed by region id (a region has at most one). */
const mounted = new Map<string, Mounted>();
/** Last verdict per `${regionId} ${value}` — feeds the sync accessor. */
const verdictCache = new Map<string, string | null>();
/** In-flight advisory runs, so a fast typist doesn't queue duplicates. */
const inFlight = new Set<string>();

function cacheKey(regionId: string, value: unknown): string {
  return `${regionId} ${String(value)}`;
}

/**
 * Mount a consented validator for advisory as-you-type checks. NEVER mounts an
 * un-consented body — that is the same rule the object-script and chart-library
 * gates follow, and the Rust submit gate enforces it independently.
 *
 * Rejects if the mount is blocked (Script Security "disabled") or the source
 * fails to load; callers degrade to "no advisory check", which costs the user
 * nothing but a later error at submit.
 */
export async function mountWritebackValidator(
  descriptor: WritebackValidatorDescriptor
): Promise<void> {
  if (!descriptor.consented) {
    throw new Error(
      `The validator "${descriptor.name}" from ${descriptor.packageName} has not been approved to run.`,
    );
  }
  unmountWritebackValidator(descriptor.regionId);
  const { id, instanceId } = mountIds(descriptor.packageName, descriptor.name);
  await hostMountScript({
    id,
    name: `Writeback validator "${descriptor.name}" (${descriptor.packageName})`,
    objectType: MOUNT_OBJECT_TYPE,
    instanceId,
    source: generateValidatorWorkerSource(descriptor.source),
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: descriptor.packageName,
    packageVersion: descriptor.packageVersion,
    // A validator is a pure predicate: the declared-capability ceiling is
    // EMPTY, so the broker denies every privileged call it could attempt.
    declaredCapabilities: [],
    apiVersion: "1.0.0",
  });
  mounted.set(descriptor.regionId, { descriptor, instanceId, scriptId: id });
}

/** Unmount the validator of one region (no-op when none is mounted). */
export function unmountWritebackValidator(regionId: string): void {
  const entry = mounted.get(regionId);
  if (!entry) return;
  try {
    hostUnmountScript(entry.scriptId);
  } catch {
    /* best-effort */
  }
  mounted.delete(regionId);
  for (const key of [...verdictCache.keys()]) {
    if (key.startsWith(`${regionId} `)) verdictCache.delete(key);
  }
}

/** Unmount every mounted validator (workbook close / extension deactivate). */
export function unmountWritebackValidators(): void {
  for (const regionId of [...mounted.keys()]) unmountWritebackValidator(regionId);
  verdictCache.clear();
  inFlight.clear();
}

/** The regions that currently have an advisory validator mounted. */
export function mountedWritebackValidators(): WritebackValidatorDescriptor[] {
  return [...mounted.values()].map((m) => m.descriptor);
}

/**
 * Run a region's mounted validator in the worker realm. Resolves to null when
 * the value is acceptable (or no validator is mounted — this is advisory) and
 * to a message when it is rejected.
 */
export async function runWritebackValidatorAsync(
  regionId: string,
  value: unknown,
  ctx: WritebackValidatorContext
): Promise<string | null> {
  const entry = mounted.get(regionId);
  if (!entry) return null;
  const key = cacheKey(regionId, value);
  try {
    const verdict = (await callExposedMethod(
      MOUNT_OBJECT_TYPE,
      entry.instanceId,
      "validate",
      value,
      {
        ...ctx,
        regionId,
        packageName: entry.descriptor.packageName,
        packageVersion: entry.descriptor.packageVersion,
      },
    )) as string | null | undefined;
    const normalized = typeof verdict === "string" && verdict.trim() !== "" ? verdict : null;
    verdictCache.set(key, normalized);
    return normalized;
  } catch {
    // A faulted worker must not block typing. The authoritative gate at submit
    // does not depend on this run.
    verdictCache.set(key, null);
    return null;
  }
}

/**
 * SYNCHRONOUS advisory verdict, for commit guards that cannot await a worker
 * round-trip in-line.
 *
 * Resolution order:
 *   1. a LOCALLY registered validator of that name runs immediately (author-side
 *      testing before publishing);
 *   2. otherwise the cached verdict for this exact (region, value) pair, from a
 *      previous advisory run;
 *   3. otherwise null (accept), and an advisory run is scheduled so the next
 *      attempt at the same value is judged.
 *
 * Returning null here is never a security decision: it only means "no advisory
 * opinion yet". Nothing reaches the registry without the Rust gate's verdict.
 */
export function runWritebackValidator(
  nameOrRegionId: string | undefined | null,
  value: unknown,
  ctx: WritebackValidatorContext
): string | null {
  const local = nameOrRegionId ? authored.get(nameOrRegionId.trim()) : undefined;
  if (local) {
    try {
      const r = local.validate(value, ctx);
      if (r === true || r === null || r === undefined) return null;
      if (typeof r === "string") return r.trim() === "" ? null : r;
      if (r === false) return "Value rejected by the validator.";
      return "The validator gave no usable verdict.";
    } catch (error) {
      console.error(`[WritebackValidators] "${nameOrRegionId}" threw:`, error);
      return "the validator threw: " + (error instanceof Error ? error.message : String(error));
    }
  }

  const regionId = ctx.regionId;
  if (!mounted.has(regionId)) return null;
  const key = cacheKey(regionId, value);
  if (verdictCache.has(key)) return verdictCache.get(key) ?? null;
  if (!inFlight.has(key)) {
    inFlight.add(key);
    void runWritebackValidatorAsync(regionId, value, ctx).finally(() => inFlight.delete(key));
  }
  return null;
}
