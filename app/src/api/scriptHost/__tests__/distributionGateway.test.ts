//! FILENAME: app/src/api/scriptHost/__tests__/distributionGateway.test.ts
// PURPOSE: Guard the six non-negotiable properties of scripted .calp
//          distribution (B3) — the first capability family whose blast radius
//          leaves the local machine:
//            1. a script can NEVER consent on the user's behalf;
//            2. verification is IDENTICAL on the script path and the UI path;
//            3. a script may act only on registries the USER configured;
//            4. publishing needs Ed25519 key POSSESSION, not just the grant;
//            5. SELF-UPDATE re-prompts — a refresh that changes the calling
//               script's own source must not silently execute new code;
//            6. publishes are rate-limited hard and every action is audited.
//          Plus the vocabulary plumbing that makes a new capability id real,
//          and the `kind: "library"` authoring gap this wave closed.
// CONTEXT: The frontend halves are asserted here directly; the Rust halves are
//          asserted by READING app/src-tauri/src/scripting/distribution_gateway.rs
//          and the two vocabulary lists, so a Rust-side deletion breaks this
//          suite instead of silently disarming the gate. The Rust file has its
//          own unit tests for its own logic — these are the cross-language
//          pairings, which is exactly where the four previous silent-strip
//          incidents lived.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET } from "../capabilityIds";
import { ALLOWLIST } from "../allowlist";
import { describeCapability, RUST_MIRRORED_CAPABILITIES } from "../capabilities";
import {
  vDistNextVersion,
  vDistPackageRef,
  vDistPublish,
  vDistPublishModel,
  vDistPublishPreview,
  vDistRegistry,
} from "../validators";
import {
  SCRIPT_SURFACES,
  auditScriptSurfaceCapabilities,
  brokerGatedCapabilities,
} from "../../scriptSurfaces";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";
import { isConsentCurrent, sha256Hex, type ConsentRecord } from "../../distributedConsent";
import { LIBRARY_PACKAGE_KIND as DIST_LIBRARY_KIND } from "../../distribution";
import { LIBRARY_PACKAGE_KIND as CONSUMER_LIBRARY_KIND } from "../../scriptLibraries/registry";
import { listPackageKinds, getPackageKind } from "../../packageKinds";

const PUBLISH_CAP = "distribution.publish";
const SUBSCRIBE_CAP = "distribution.subscribe";

/** Every broker method of the family, split by the capability that gates it. */
const SUBSCRIBE_METHODS = [
  "cap.pkgListRegistries",
  "cap.pkgListSubscriptions",
  "cap.pkgBrowse",
  "cap.pkgInspect",
  "cap.pkgPull",
  "cap.pkgRefreshPreview",
  "cap.pkgRefreshApply",
];
const PUBLISH_METHODS = [
  "cap.pkgPublishPreview",
  "cap.pkgNextVersion",
  "cap.pkgPublish",
  "cap.pkgPublishModel",
];
const ALL_PKG_METHODS = [...SUBSCRIBE_METHODS, ...PUBLISH_METHODS];

const repoFile = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), "utf8");

/**
 * The text between two markers, THROWING if either is missing.
 *
 * Every source-reading guard below narrows to one function before asserting,
 * and a plain `slice(indexOf(a), indexOf(b))` silently degrades when a marker
 * moves: `indexOf` returns -1, the slice becomes "everything to the end", and a
 * `toContain` assertion then passes against some unrelated part of the file.
 * That is not a theoretical worry — it happened while writing this suite and
 * made the single most important guard (is `pull` registry-gated?) vacuously
 * green while the gate was actually removed. A missing marker must be a FAILURE.
 */
function sliceBetween(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  if (from < 0) throw new Error(`marker not found: ${start}`);
  const to = src.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`marker not found after "${start}": ${end}`);
  return src.slice(from, to);
}

const gatewaySrc = repoFile("../../../../src-tauri/src/scripting/distribution_gateway.rs");
const capabilityStoreSrc = repoFile("../../../../src-tauri/src/scripting/capability_store.rs");
const persistenceSrc = repoFile("../../../../../core/persistence/src/lib.rs");
const hostSrc = repoFile("../host.ts");
const calpCommandsSrc = repoFile("../../../../src-tauri/src/calp_commands.rs");

// ============================================================================
// 0. Vocabulary: two ids, threaded everywhere, never collapsed into one
// ============================================================================

describe("the two distribution directions are two capabilities", () => {
  it("are both in the one vocabulary", () => {
    for (const cap of [PUBLISH_CAP, SUBSCRIBE_CAP]) {
      expect(ALL_CAPABILITY_IDS).toContain(cap);
      expect(CAPABILITY_ID_SET.has(cap as never)).toBe(true);
    }
    expect(PUBLISH_CAP).not.toBe(SUBSCRIBE_CAP);
  });

  it("each has consent text that names ITS OWN risk, not the union", () => {
    const outbound = describeCapability(PUBLISH_CAP as never);
    const inbound = describeCapability(SUBSCRIBE_CAP as never);
    expect(outbound).not.toBe(PUBLISH_CAP);
    expect(inbound).not.toBe(SUBSCRIBE_CAP);
    // Outbound: whose identity it uses, and that it cannot be recalled.
    expect(outbound.toLowerCase()).toContain("your publisher key");
    expect(outbound.toLowerCase()).toMatch(/cannot be taken back|leaves this machine/);
    // Inbound: that it is SOMEBODY ELSE'S code, and that the user still decides.
    expect(inbound.toLowerCase()).toContain("somebody else");
    expect(inbound.toLowerCase()).toMatch(/switched off|approve/);
    // Neither may describe the other's reach — that is the whole point of the
    // split, and the failure mode is a user granting "refresh my data" and
    // getting "publish under my name".
    expect(inbound.toLowerCase()).not.toContain("publisher key");
  });

  it("both are mirrored into the authoritative Rust capability store", () => {
    // The TS broker gate is advisory; script_distribution re-checks in Rust. An
    // id the frontend mirrors but the backend's allowlist omits makes the
    // capability look implemented while being permanently denied.
    for (const cap of [PUBLISH_CAP, SUBSCRIBE_CAP]) {
      expect(RUST_MIRRORED_CAPABILITIES.has(cap as never)).toBe(true);
      expect(capabilityStoreSrc).toContain(`"${cap}"`);
    }
  });

  it("both are in KNOWN_CAPABILITY_IDS, so a declaration is not stripped at save", () => {
    // The silent-strip incident class: an id missing here is removed from a
    // local script's ceiling at save AND from a .calp at publish, so a script
    // that correctly declared it is denied with no diagnostic.
    const block = persistenceSrc.match(
      /pub const KNOWN_CAPABILITY_IDS: \[&str; (\d+)\] = \[([\s\S]*?)\];/,
    );
    expect(block, "KNOWN_CAPABILITY_IDS not found").toBeTruthy();
    const ids = [...(block as RegExpMatchArray)[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...ALL_CAPABILITY_IDS]);
    expect(Number((block as RegExpMatchArray)[1])).toBe(ALL_CAPABILITY_IDS.length);
  });

  it("every allowlist row names exactly one of the two, never both", () => {
    for (const m of SUBSCRIBE_METHODS) {
      expect(ALLOWLIST[m], `${m} missing from ALLOWLIST`).toBeDefined();
      expect(ALLOWLIST[m].capability, m).toBe(SUBSCRIBE_CAP);
    }
    for (const m of PUBLISH_METHODS) {
      expect(ALLOWLIST[m], `${m} missing from ALLOWLIST`).toBeDefined();
      expect(ALLOWLIST[m].capability, m).toBe(PUBLISH_CAP);
    }
    const gated = Object.entries(ALLOWLIST)
      .filter(([, p]) => p.capability === PUBLISH_CAP || p.capability === SUBSCRIBE_CAP)
      .map(([m]) => m)
      .sort();
    expect(gated).toEqual([...ALL_PKG_METHODS].sort());
  });

  it("every worker-realm surface with an author-declared ceiling declares both", () => {
    const gated = brokerGatedCapabilities();
    expect(gated).toContain(PUBLISH_CAP);
    expect(gated).toContain(SUBSCRIBE_CAP);
    for (const s of SCRIPT_SURFACES) {
      if (s.runtime !== "worker-realm" || s.mountCeiling) continue;
      // The sandboxed-extension surface is EXCLUDED here, and its exclusion is
      // the decision recorded in "a sandboxed EXTENSION has no door" below: it
      // reaches the broker only through EXTENSION_BROKER_METHODS, which has no
      // cap.pkg* row, so listing these two on that row would name reach the
      // broker refuses. `auditScriptSurfaceCapabilities` derives that row
      // separately and is asserted immediately after, so the exclusion cannot
      // hide an understatement.
      if (s.id === "extension-worker") continue;
      expect(s.capabilities, `${s.id} understates its reach`).toContain(PUBLISH_CAP);
      expect(s.capabilities, `${s.id} understates its reach`).toContain(SUBSCRIBE_CAP);
    }
    for (const a of auditScriptSurfaceCapabilities()) {
      expect(a.understated, `${a.surfaceId} understated`).toEqual([]);
    }
  });
});

// ============================================================================
// 1. A SCRIPT CAN NEVER CONSENT ON THE USER'S BEHALF
// ============================================================================

describe("rule 1 — pulled code arrives switched off", () => {
  it("the Rust gateway never mounts, grants or consents", () => {
    const production = gatewaySrc.split("#[cfg(test)]")[0];
    for (const forbidden of [
      "grant_script_capability",
      "grant_script_net_origin",
      "applyConsentedCapabilities",
      "mountScript",
      "ScriptEngine",
    ]) {
      expect(production, `gateway must never ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the pull path materializes object scripts restricted + distributed", () => {
    // Enforced in core/calp/src/pull.rs, which the gateway reaches through
    // calp_pull — so the script path inherits it rather than reimplementing it.
    const pullSrc = repoFile("../../../../../core/calp/src/pull.rs");
    expect(pullSrc).toContain("script.access_level = persistence::ScriptAccessLevel::Restricted");
    expect(pullSrc).toContain("script.provenance = persistence::ScriptProvenance::Distributed");
  });

  it("the broker's pull handler announces the package instead of mounting it", () => {
    // The ONLY renderer-side side effects of a scripted pull: materialize the
    // custom objects an interactive pull materializes, and fire PACKAGE_UPDATED
    // so the consent flow runs. Neither mounts anything.
    expect(hostSrc).toContain("async function announcePulledPackage");
    expect(hostSrc).toContain("applyPulledCustomObjects");
    expect(hostSrc).toContain("AppEvents.PACKAGE_UPDATED");
    const helper = sliceBetween(hostSrc, "async function announcePulledPackage", "/** The IMPL table");
    expect(helper).not.toContain("mountScript");
    expect(helper).not.toContain("applyConsentedCapabilities");
    expect(helper).not.toContain("recordConsent");
  });

  it("a distributed script cannot reach the family AT ALL (tier, not promise)", () => {
    // calp::pull forces every pulled object script to the RESTRICTED tier, and
    // every cap.pkg* row is "unlocked" — so a package's own scripts can never
    // pull further packages or publish. This is what keeps the capability from
    // becoming a self-propagating code channel, and it is structural: no
    // consent prompt can grant it.
    for (const m of ALL_PKG_METHODS) {
      expect(ALLOWLIST[m].tier, `${m} must be unlocked-tier`).toBe("unlocked");
    }
  });

  it("a sandboxed EXTENSION has no door to the family either", () => {
    // Deliberate v1 decision: an extension's code lives in %APPDATA%, outside
    // the per-file code inventory, so letting it pull MORE third-party content
    // into the workbook chains one un-inventoried surface onto another.
    for (const m of ALL_PKG_METHODS) {
      expect(EXTENSION_BROKER_METHODS.has(m), `${m} must not be extension-reachable`).toBe(false);
    }
  });
});

// ============================================================================
// 2. VERIFICATION IS IDENTICAL ON BOTH PATHS
// ============================================================================

describe("rule 2 — the script path is the same code as the UI path", () => {
  it("the gateway dispatches into the calp_* commands the UI calls", () => {
    for (const dispatch of [
      "calp_cmds::calp_pull(",
      "calp_cmds::calp_refresh_apply(",
      "calp_cmds::calp_refresh_preview(",
      "calp_cmds::calp_inspect_package(",
      "calp_cmds::calp_browse_registry(",
      "calp_cmds::calp_publish(",
      "calp_cmds::calp_publish_model(",
      "calp_cmds::calp_publish_preview(",
      "calp_cmds::calp_next_version(",
      "calp_cmds::calp_get_subscriptions(",
    ]) {
      expect(gatewaySrc, `missing dispatch ${dispatch}`).toContain(dispatch);
    }
  });

  it("the gateway holds NO copy of signature / TOFU / integrity / compat logic", () => {
    const production = gatewaySrc.split("#[cfg(test)]")[0];
    for (const forbidden of [
      "calp::pull::pull(",
      "calp::publish::publish(",
      "calp::refresh::pull_all_updates(",
      "verify_signature(",
      "pin_publisher(",
      "check_min_app_version(",
      "verify_and_load_manifest",
    ]) {
      expect(production, `gateway must not reimplement ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the ONE verification path really does run all four checks", () => {
    // Asserted at the source the both paths share, so "identical" is a fact
    // about one function rather than a claim about two.
    const pullSrc = repoFile("../../../../../core/calp/src/pull.rs");
    expect(pullSrc).toContain("verify_and_load_manifest_via");
    expect(pullSrc).toContain("check_min_app_version");
    const refreshSrc = repoFile("../../../../../core/calp/src/refresh.rs");
    expect(refreshSrc).toContain("pull::pull(registry, &request, profile_dir)");
  });
});

// ============================================================================
// 3. ONLY REGISTRIES THE USER CONFIGURED
// ============================================================================

describe("rule 3 — a script cannot name a registry the user did not add", () => {
  it("every action carrying a registryPath is gated, pull included", () => {
    // The matches!(...) body of names_a_registry ONLY. A wider slice finds
    // these variants elsewhere in the file and proves nothing — which is
    // exactly how this guard was vacuously green while `Action::Pull` had been
    // deleted from the gate.
    const body = /fn names_a_registry\(self\) -> bool \{([\s\S]*?)\n    \}/.exec(gatewaySrc);
    expect(body, "fn names_a_registry not found").toBeTruthy();
    const fn = (body as RegExpExecArray)[1];
    for (const action of [
      "Action::BrowseRegistry",
      "Action::InspectPackage",
      "Action::Pull",
      "Action::NextVersion",
      "Action::Publish",
      "Action::PublishModel",
    ]) {
      expect(fn, `${action} must be registry-gated`).toContain(action);
    }
  });

  it("the gate is fed by saved registries AND existing subscriptions only", () => {
    expect(gatewaySrc).toContain("fn require_configured_registry");
    const fn = sliceBetween(gatewaySrc, "fn configured_registries", "fn require_configured_registry");
    expect(fn).toContain("calp_list_registries");
    expect(fn).toContain("state.subscriptions");
    // Nothing else may widen the set — in particular not the payload.
    expect(fn).not.toContain("payload");
  });

  it("the refusal names the fix rather than just saying no", () => {
    expect(gatewaySrc).toContain("RegistryNotConfigured:");
    expect(gatewaySrc).toContain("registries you added yourself");
    expect(gatewaySrc).toContain("Add registry");
  });

  it("adding a registry and dev-subscribing are NOT dispatchable", () => {
    // The two actions that would let a script widen the trust set itself. A
    // dev subscription is the sharpest: it takes an arbitrary local .cala path
    // with no signature, no publisher key and no pin.
    const parse = sliceBetween(gatewaySrc, "fn parse(raw: &str)", "fn as_str(self)");
    for (const refused of [
      "addRegistry",
      "removeRegistry",
      "devSubscribe",
      "devRefresh",
      "detach",
      "resetSubscription",
      "acceptUpstream",
      "importOverrides",
      "saveDataSourceConfig",
      "refreshData",
      "exportPackageHtml",
    ]) {
      expect(parse, `'${refused}' must not be a dispatchable action`).not.toContain(
        `"${refused}"`,
      );
    }
  });

  it("no broker handler can send one of the refused actions either", () => {
    // Defence in depth: the Rust allowlist refuses them, and no TS path even
    // tries. A handler that sent one would be a bug the Rust side would catch,
    // but it would also be a lie in the transparency panel.
    const block = sliceBetween(hostSrc, 'case "cap.pkgListRegistries"', 'case "cap.connectorRegister"');
    expect(block.length).toBeGreaterThan(500);
    for (const refused of ["detach", "devSubscribe", "addRegistry", "importOverrides"]) {
      expect(block).not.toContain(`"${refused}"`);
    }
  });
});

// ============================================================================
// 4. PUBLISHING NEEDS THE KEY, NOT JUST THE GRANT
// ============================================================================

describe("rule 4 — Ed25519 publisher-key possession", () => {
  it("a publish is gated on an EXISTING key, never one it creates", () => {
    const fn = sliceBetween(gatewaySrc, "fn require_publish_identity", "fn publisher_display_name");
    // load_existing NEVER creates; load_or_create would MINT the identity other
    // people TOFU-pin as the user, which is not a script's decision to make.
    expect(fn).toContain("PublisherKeypair::load_existing");
    expect(fn).not.toContain("load_or_create");
    expect(fn).toContain("NoPublisherKey:");
  });

  it("an EXISTING package additionally needs THAT package's key", () => {
    const fn = sliceBetween(gatewaySrc, "fn require_publish_identity", "fn publisher_display_name");
    // The same gate the writeback review actions pass — reused, not rewritten.
    expect(fn).toContain("calp_cmds::require_publisher(");
    expect(fn).toContain("NotThePublisher:");
    expect(calpCommandsSrc).toContain("pub(crate) fn require_publisher");
    expect(calpCommandsSrc).toContain("profile_holds_publisher_key");
  });

  it("the gate runs BEFORE dispatch and only for registry writes", () => {
    expect(gatewaySrc).toContain("if act.is_publishing_write() {");
    const isWrite = sliceBetween(gatewaySrc, "fn is_publishing_write", "fn bucket(self)");
    expect(isWrite).toContain("Action::Publish | Action::PublishModel");
    // ...and the denial is audited as a capability event, not just an error.
    const step5 = sliceBetween(gatewaySrc, "// (5) Publisher-key possession", "// (6) Rate limits.");
    expect(step5).toContain("record_capability_call");
  });

  it("a script cannot publish under somebody else's byline", () => {
    expect(gatewaySrc).toContain("fn reject_forbidden_publish_fields");
    expect(gatewaySrc).toContain("publisher_display_name()?");
    // The validator says the same thing early, by name.
    const err = vDistPublish([
      { registry: "C:/reg", packageName: "p", version: "1.0.0", publishedBy: "Microsoft" },
    ]);
    expect(err).toContain("publishedBy");
    expect(err).toContain("identity");
  });
});

// ============================================================================
// 5. SELF-UPDATE — the sharp edge
// ============================================================================

describe("rule 5 — a refresh that changes the calling script cannot run it", () => {
  const CHANGED_SOURCE = "function setup(context) { context.log('v2 — new behaviour'); }";
  const ORIGINAL_SOURCE = "function setup(context) { context.log('v1'); }";

  async function recordFor(source: string): Promise<ConsentRecord> {
    return {
      packageName: "vendor-kpis",
      scripts: [{ id: "s1", sourceHash: await sha256Hex(source), source }],
      grantedCapabilities: [],
      grantedAt: new Date().toISOString(),
    };
  }

  it("consent is keyed by SOURCE HASH, so an unchanged script stays approved", async () => {
    const consents = [await recordFor(ORIGINAL_SOURCE)];
    await expect(
      isConsentCurrent(consents, "vendor-kpis", [{ id: "s1", source: ORIGINAL_SOURCE }]),
    ).resolves.toBe(true);
  });

  it("THE CASE: the refresh replaced the script's own source -> NOT current", async () => {
    // This is the self-update scenario end to end. A script calls
    // caps.packages.refreshApply(); the refresh pulls a newer version of a
    // package whose object script is the caller itself; the new source hashes
    // differently; consent is no longer current; ScriptableObjects therefore
    // does NOT mount it and raises a consent prompt with the diff instead.
    const consents = [await recordFor(ORIGINAL_SOURCE)];
    await expect(
      isConsentCurrent(consents, "vendor-kpis", [{ id: "s1", source: CHANGED_SOURCE }]),
    ).resolves.toBe(false);
  });

  it("a script ADDED by the refresh is not covered by the old consent", async () => {
    const consents = [await recordFor(ORIGINAL_SOURCE)];
    await expect(
      isConsentCurrent(consents, "vendor-kpis", [
        { id: "s1", source: ORIGINAL_SOURCE },
        { id: "s2", source: "function setup(context) {}" },
      ]),
    ).resolves.toBe(false);
  });

  it("a capability EXPANSION in the new version re-prompts even if consent existed", async () => {
    // The other half of the self-update risk: same script id, new pragma. The
    // consented capability set must equal the declared one.
    const consents = [await recordFor(ORIGINAL_SOURCE)];
    const widened = `// @capability net.fetch\n${ORIGINAL_SOURCE}`;
    await expect(
      isConsentCurrent(consents, "vendor-kpis", [{ id: "s1", source: widened }]),
    ).resolves.toBe(false);
  });

  it("the mount path is the one that re-checks, and the gateway is not in it", () => {
    // Rust returns DATA. The renderer's ScriptableObjects extension is the only
    // thing that mounts, and it consults isConsentCurrent first.
    const objectScripts = repoFile("../../../../extensions/ScriptableObjects/index.ts");
    expect(objectScripts).toContain("isConsentCurrent");
    expect(objectScripts).toContain("getChangedScripts");
    const production = gatewaySrc.split("#[cfg(test)]")[0];
    expect(production).not.toContain("isConsentCurrent");
  });
});

// ============================================================================
// 6. RATE LIMITS + AUDIT
// ============================================================================

describe("rule 6 — publishes are limited hard and everything is audited", () => {
  it("the publish bucket is the tightest, and has a session ceiling too", () => {
    const limits = (m: string): number => (ALLOWLIST[m].limits?.perMinute as number) ?? 0;
    expect(limits("cap.pkgPublish")).toBeLessThanOrEqual(3);
    expect(limits("cap.pkgPublishModel")).toBeLessThanOrEqual(3);
    expect(limits("cap.pkgPull")).toBeLessThan(limits("cap.pkgInspect"));
    expect(limits("cap.pkgRefreshApply")).toBeLessThan(limits("cap.pkgRefreshPreview"));
    // The Rust side is authoritative and additionally caps a whole session.
    expect(gatewaySrc).toContain("const PUBLISHES_PER_SESSION");
    expect(gatewaySrc).toContain("fn check_session_publish_budget");
  });

  it("everything that contacts a registry is classed as leaving the machine", () => {
    // class "net" is what the transparency panel and the audit ring read as
    // "this left the building". A publish classed "mutate" would be
    // under-reported exactly where it matters most.
    for (const m of [
      "cap.pkgBrowse",
      "cap.pkgInspect",
      "cap.pkgPull",
      "cap.pkgRefreshPreview",
      "cap.pkgRefreshApply",
      "cap.pkgNextVersion",
      "cap.pkgPublish",
      "cap.pkgPublishModel",
    ]) {
      expect(ALLOWLIST[m].class, `${m} must be class "net"`).toBe("net");
    }
    // ...and the two purely local enumerations are honestly NOT net.
    expect(ALLOWLIST["cap.pkgListRegistries"].class).toBe("read");
    expect(ALLOWLIST["cap.pkgListSubscriptions"].class).toBe("read");
    expect(ALLOWLIST["cap.pkgPublishPreview"].class).toBe("read");
  });

  it("the audit detail names WHAT moved and TO/FROM where", () => {
    const fn = sliceBetween(gatewaySrc, "fn audit_detail(", "fn subscribed_packages_summary");
    expect(fn).toContain('s("packageName")');
    expect(fn).toContain('s("version")');
    expect(fn).toContain("registry");
    expect(fn).toContain("->"); // publish: to where
    expect(fn).toContain("<-"); // pull: from where
  });

  it("both outcomes are audited, on every denial branch", () => {
    // Four denial branches (grant, registry, publisher key, rate) plus the
    // success/failure pair. A denial that is not audited is a denial the user
    // cannot discover afterwards.
    const command = sliceBetween(gatewaySrc, "pub fn script_distribution(", "/// The audit `detail` for an action");
    const calls = command.match(/record_capability_call\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it("the description of every row says what a non-programmer needs to know", () => {
    for (const m of ALL_PKG_METHODS) {
      expect(ALLOWLIST[m].desc.length, `${m} desc too short`).toBeGreaterThan(40);
    }
    // The two that must not be soft-pedalled.
    expect(ALLOWLIST["cap.pkgPublish"].desc.toLowerCase()).toContain("cannot be taken back");
    expect(ALLOWLIST["cap.pkgPull"].desc.toLowerCase()).toContain("somebody else");
  });
});

// ============================================================================
// 7. Validators — the cheap pre-flight that names the problem early
// ============================================================================

describe("distribution validators", () => {
  it("a registry location must be a bounded, non-empty string", () => {
    expect(vDistRegistry(["C:/registries/team"])).toBe(true);
    expect(vDistRegistry([""])).toContain("non-empty");
    expect(vDistRegistry(["   "])).toContain("non-empty");
    expect(vDistRegistry([42])).toContain("non-empty");
    expect(vDistRegistry(["x".repeat(5000)])).toContain("non-empty");
  });

  it("a package reference needs registry + name + pin", () => {
    expect(vDistPackageRef(["C:/reg", "vendor-kpis", "^1.0.0"])).toBe(true);
    expect(vDistPackageRef(["C:/reg", "vendor-kpis", "latest"])).toBe(true);
    expect(vDistPackageRef(["", "vendor-kpis", "latest"])).toContain("registry");
    expect(vDistPackageRef(["C:/reg", "", "latest"])).toContain("packageName");
    expect(vDistPackageRef(["C:/reg", "vendor-kpis", ""])).toContain("versionPin");
  });

  it("nextVersion accepts only the three bump levels", () => {
    for (const bump of ["major", "minor", "patch"]) {
      expect(vDistNextVersion(["C:/reg", "p", bump])).toBe(true);
    }
    expect(vDistNextVersion(["C:/reg", "p", "prerelease"])).toContain("bump must be one of");
    expect(vDistNextVersion(["C:/reg", "p", ""])).toContain("bump must be one of");
  });

  it("publishPreview takes an optional, bounded sheet selection", () => {
    expect(vDistPublishPreview([])).toBe(true);
    expect(vDistPublishPreview([undefined])).toBe(true);
    expect(vDistPublishPreview([[0, 2, 5]])).toBe(true);
    expect(vDistPublishPreview([[-1]])).toContain("non-negative");
    expect(vDistPublishPreview([[1.5]])).toContain("non-negative");
    expect(vDistPublishPreview(["all"])).toContain("array");
  });

  it("a publish spec rejects EVERY field a script must not set", () => {
    const base = { registry: "C:/reg", packageName: "p", version: "1.0.0" };
    expect(vDistPublish([base])).toBe(true);
    expect(vDistPublish([{ ...base, kind: "library" }])).toBe(true);
    expect(vDistPublish([{ ...base, sheetIndices: [0, 1] }])).toBe(true);

    expect(vDistPublish([{ ...base, publishedBy: "someone" }])).toContain("publishedBy");
    expect(vDistPublish([{ ...base, customObjects: [] }])).toContain("customObjects");
    expect(vDistPublish([{ ...base, includeComments: true }])).toContain("includeComments");
    // Even `false` is refused: the field is not the script's to express an
    // opinion about, and a silently-accepted false would teach the wrong model.
    expect(vDistPublish([{ ...base, includeComments: false }])).toContain("includeComments");

    expect(vDistPublish([{ ...base, registry: "" }])).toContain("registry");
    expect(vDistPublish([{ ...base, version: "" }])).toContain("version");
    expect(vDistPublish([{ ...base, kind: "" }])).toContain("kind");
    expect(vDistPublish(["not-an-object"])).toContain("one object");
  });

  it("a model-publish spec needs a connection and rejects the same fields", () => {
    const base = { registry: "C:/reg", packageName: "p", version: "1.0.0", connectionId: "c1" };
    expect(vDistPublishModel([base])).toBe(true);
    expect(vDistPublishModel([{ ...base, connectionId: "" }])).toContain("connectionId");
    expect(vDistPublishModel([{ ...base, publishedBy: "x" }])).toContain("publishedBy");
    expect(vDistPublishModel([null])).toContain("one object");
  });
});

// ============================================================================
// 8. The `kind: "library"` authoring gap
// ============================================================================

describe("a library author can finally publish one", () => {
  it("the publishing spelling matches the consuming spelling exactly", () => {
    // library_commands.rs resolves a library by comparing this string; the
    // package manager filters a registry listing by it. Three copies of one
    // literal is two too many to leave unpinned.
    expect(DIST_LIBRARY_KIND).toBe("library");
    expect(DIST_LIBRARY_KIND).toBe(CONSUMER_LIBRARY_KIND);
    const libSrc = repoFile("../../../../src-tauri/src/library_commands.rs");
    expect(libSrc).toContain(`LIBRARY_KIND: &str = "${DIST_LIBRARY_KIND}"`);
  });

  it("the publish picker offers it (it did not, so nobody could ship one)", () => {
    const kinds = listPackageKinds().map((k) => k.id);
    expect(kinds).toContain("library");
    expect(getPackageKind("library")?.label).toBe("Script library");
    // The three original built-ins keep their order and position.
    expect(kinds.slice(0, 3)).toEqual(["report", "template", "dataset"]);
  });

  it("a library publishes ZERO sheets by default, not the whole workbook", () => {
    // The trap this closes: every other kind reads an empty sheet selection as
    // "all sheets", so publishing a function library would have shipped the
    // author's entire workbook — data included — to a shared registry.
    expect(calpCommandsSrc).toContain("library_commands::LIBRARY_KIND");
    const block = sliceBetween(
      calpCommandsSrc,
      "let sheet_indices = if params.kind",
      "let assembly = assemble_publish_workbook",
    );
    expect(block).toContain("params.sheet_indices");
    expect(block).toContain("resolve_publish_sheet_indices");
  });

  it("the scripted publish path can emit the library kind", () => {
    // `kind` is forwarded, and the validator accepts it — so a build script can
    // publish a library the same way the dialog now can.
    expect(vDistPublish([
      { registry: "C:/reg", packageName: "acme.stats", version: "1.0.0", kind: "library" },
    ])).toBe(true);
    expect(hostSrc).toContain("kind: spec.kind ?? null");
  });
});
