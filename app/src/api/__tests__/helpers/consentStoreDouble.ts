//! FILENAME: app/src/api/__tests__/helpers/consentStoreDouble.ts
// PURPOSE: ONE in-memory double of the Rust consent store -- the two commands
//          `list_script_consents` and `record_script_consent`
//          (app/src-tauri/src/consent_seal.rs) -- for every suite that drives the
//          REAL @api/distributedConsent over a fake backend.
// CONTEXT: Before approvals were sealed to this computer, each such suite
//          doubled the consent FILE (readVirtualFile / createVirtualFile over a
//          Map) and asserted on its JSON bytes. The store no longer touches that
//          file from TypeScript; Rust writes and verifies it. This double answers
//          the way Rust does:
//            * it hashes with node:crypto, so it can never agree with a wrong
//              TypeScript hash by construction;
//            * it refuses what Rust refuses (an empty list, a duplicate or empty
//              id, a blank application, a `buttonAction:` id that does not
//              name the sha256 of the source beside it, and ANY field beyond
//              `{ packageName, scripts: [{ id, source }], grantedCapabilities }`
//              -- Rust denies unknown fields), rejecting with a STRING, as a
//              Tauri command error arrives;
//            * a record replaces this computer's earlier record for the same
//              application and nothing else.
//          `grantedIn` is `consent_granted_in` over what was recorded -- the
//          question the Rust gates ask.
//
// USAGE (the factory must only close over the double -- vi.mock is hoisted):
//
//   import { createConsentStoreDouble } from "<path>/helpers/consentStoreDouble";
//   const consentStore = createConsentStoreDouble();
//   vi.mock("../backend", () => ({
//     invokeBackend: (cmd: string, args?: Record<string, unknown>) => consentStore.invoke(cmd, args),
//   }));
//
// A suite whose backend double serves other commands too asks
// `consentStore.handles(cmd)` first and falls through to its own answers.

import { createHash } from "node:crypto";

export interface DoubleConsentScript {
  id: string;
  sourceHash: string;
  source?: string;
}

export interface DoubleCapabilityGrant {
  capability: string;
  origins?: string[];
}

export interface DoubleConsentRecord {
  packageName: string;
  scripts: DoubleConsentScript[];
  grantedCapabilities: DoubleCapabilityGrant[];
  grantedAt: string;
}

export type DoubleIgnoredReason = "unsealed" | "otherComputer" | "altered" | "keyUnavailable";

export interface DoubleIgnoredConsent {
  packageName: string;
  reason: DoubleIgnoredReason;
}

export interface ConsentStoreDouble {
  /** Whether `cmd` is one of the two consent commands this double answers. */
  handles(cmd: string): boolean;
  /** The invokeBackend double. Rejects for any command it does not answer. */
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /** What this computer's store holds, as Rust would list it (deep copies). */
  records(): DoubleConsentRecord[];
  /** `consent_granted_in` over what was recorded, hashing `source` itself. */
  grantedIn(packageKey: string, scriptId: string, source: string): boolean;
  /** SHA-256 hex, computed with node:crypto. */
  hash(source: string): string;
  /** Every `record_script_consent` request exactly as it arrived, in order. */
  readonly requests: Array<Record<string, unknown>>;
  /** How many times `list_script_consents` was asked. */
  readonly listCalls: () => number;
  /** Make every following record REJECT with `reason` (null restores). */
  refuseRecords(reason: string | null): void;
  /** The records Rust would report as not counting here. */
  setIgnored(ignored: DoubleIgnoredConsent[]): void;
  /** A record this computer sealed earlier (as if loaded with the workbook). */
  seed(record: { packageName: string; scripts: Array<{ id: string; source: string }>; grantedCapabilities?: DoubleCapabilityGrant[] }): void;
  /** Forget everything: records, requests, refusals, ignored, counters. */
  reset(): void;
}

/** The approval id prefix of BUTTON code (Rust `BUTTON_ACTION_CONSENT_PREFIX`):
 *  the id is this + sha256 of the exact bytes. */
const BUTTON_ACTION_PREFIX = "buttonAction:";

const REQUEST_KEYS = new Set(["packageName", "scripts", "grantedCapabilities"]);
const SCRIPT_KEYS = new Set(["id", "source"]);
const GRANT_KEYS = new Set(["capability", "origins"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unknownField(value: unknown, allowed: Set<string>): string | null {
  if (!value || typeof value !== "object") return "(not an object)";
  for (const key of Object.keys(value)) if (!allowed.has(key)) return key;
  return null;
}

export function createConsentStoreDouble(): ConsentStoreDouble {
  let stored: DoubleConsentRecord[] = [];
  let ignored: DoubleIgnoredConsent[] = [];
  let refusal: string | null = null;
  let lists = 0;
  const requests: Array<Record<string, unknown>> = [];

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  /** Rust's validation, and its `deny_unknown_fields`, as the rejection string. */
  function refusalFor(request: unknown): string | null {
    const top = unknownField(request, REQUEST_KEYS);
    if (top) return `unknown field \`${top}\` in record_script_consent's request`;
    const r = request as { packageName?: unknown; scripts?: unknown; grantedCapabilities?: unknown };
    if (typeof r.packageName !== "string" || r.packageName.trim() === "") {
      return "the approval does not name the application it approves";
    }
    if (!Array.isArray(r.scripts) || r.scripts.length === 0) {
      return "the approval lists no code, and an approval covers exactly the code the approval screen showed";
    }
    const seen = new Set<string>();
    for (const s of r.scripts) {
      const extra = unknownField(s, SCRIPT_KEYS);
      if (extra) return `unknown field \`${extra}\` in a script of record_script_consent's request`;
      const script = s as { id?: unknown; source?: unknown };
      if (typeof script.id !== "string" || typeof script.source !== "string") return "a script needs an id and a source";
      if (script.id === "") return "the approval lists a piece of code with no id";
      if (seen.has(script.id)) {
        return `the approval lists the code '${script.id}' twice, so it cannot say which copy was shown`;
      }
      seen.add(script.id);
      if (script.id.startsWith(BUTTON_ACTION_PREFIX) && script.id !== BUTTON_ACTION_PREFIX + sha256(script.source)) {
        return (
          `the approval lists the button code '${script.id}' with code that is not the code that id names, ` +
          "so it cannot say which code was shown"
        );
      }
    }
    for (const g of (r.grantedCapabilities as unknown[] | undefined) ?? []) {
      const extra = unknownField(g, GRANT_KEYS);
      if (extra) return `unknown field \`${extra}\` in a capability grant of record_script_consent's request`;
    }
    return null;
  }

  function record(packageName: string, scripts: Array<{ id: string; source: string }>, grants: DoubleCapabilityGrant[]): void {
    stored = stored.filter((c) => c.packageName !== packageName);
    stored.push({
      packageName,
      scripts: scripts.map((s) => ({ id: s.id, sourceHash: sha256(s.source), source: s.source })),
      grantedCapabilities: clone(grants),
      grantedAt: new Date().toISOString(),
    });
  }

  const double: ConsentStoreDouble = {
    handles: (cmd) => cmd === "list_script_consents" || cmd === "record_script_consent",
    async invoke(cmd, args) {
      if (cmd === "list_script_consents") {
        lists += 1;
        return { consents: clone(stored), ignored: clone(ignored) };
      }
      if (cmd === "record_script_consent") {
        const request = (args ?? {}).request as Record<string, unknown> | undefined;
        requests.push(clone(request ?? {}));
        if (refusal !== null) throw refusal;
        const refused = refusalFor(request);
        if (refused !== null) throw refused;
        const r = request as unknown as {
          packageName: string;
          scripts: Array<{ id: string; source: string }>;
          grantedCapabilities?: DoubleCapabilityGrant[];
        };
        record(r.packageName, r.scripts, r.grantedCapabilities ?? []);
        return undefined;
      }
      throw new Error(`consentStoreDouble: no answer for backend command "${cmd}"`);
    },
    records: () => clone(stored),
    grantedIn(packageKey, scriptId, source) {
      const hash = sha256(source);
      return stored.some(
        (r) => r.packageName === packageKey && r.scripts.some((s) => s.id === scriptId && s.sourceHash === hash),
      );
    },
    hash: sha256,
    requests,
    listCalls: () => lists,
    refuseRecords(reason) {
      refusal = reason;
    },
    setIgnored(next) {
      ignored = clone(next);
    },
    seed({ packageName, scripts, grantedCapabilities }) {
      record(packageName, scripts, grantedCapabilities ?? []);
    },
    reset() {
      stored = [];
      ignored = [];
      refusal = null;
      lists = 0;
      requests.length = 0;
    },
  };
  return double;
}
