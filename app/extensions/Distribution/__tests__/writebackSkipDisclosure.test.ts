//! FILENAME: app/extensions/Distribution/__tests__/writebackSkipDisclosure.test.ts
// PURPOSE: The Subscriptions pane must tell the user when something an
//          application declares was NOT loaded — its writeback form rules, or
//          its data model — and must name every reason the backend can report.
// CONTEXT: "This application declares no writeback" and "this application's
//          writeback regions could not be read, so its deadlines / required
//          fields / value checks are NOT in force" used to be the SAME
//          observable state: an empty index and a silent screen.
//          `rebuild_writeback_index` now records a `WritebackRebuildSkip` per
//          subscription it could not install, and this pane renders it.
//
//          The reason vocabulary is DERIVED from the Rust classifier, so adding
//          a reason there fails this test instead of falling through to a
//          generic sentence nobody wrote on purpose. The Rust->TS mirror and
//          the deferred-rebuild event bridge are checked here too: without the
//          bridge the pane would sit on "Loading..." forever, which reads as
//          broken rather than as protected.
//
//          The second half of the file applies the identical rule to the
//          application's BI CONNECTION, which is rebuilt on open rather than
//          stored in the `.cala`. "This application has no data source" and
//          "this application's model could not be verified on this machine"
//          were the same silent screen for the same reason.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/**
 * Strip comments before matching. The comments in these files quote the
 * behaviour they replaced, so an unstripped scan reads the old claim back out
 * of the very file that fixed it.  (`[^:]` keeps `https://` out of the rule.)
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CALP_RS = read("src-tauri/src/calp_commands.rs");
const PANE = code(read("extensions/Distribution/components/SubscriptionManagerPane.tsx"));
const DIST_TS = read("src/api/distribution.ts");
const BOOTSTRAP = code(read("src/shell/bootstrap.ts"));

/**
 * Every reason string `calp_skip_reason` can return, read from Rust.
 *
 * ONE classifier, two on-open workspace walks: the writeback-index rebuild and
 * the application-BI-connection restore both ask "why could this subscription's
 * signed manifest not be loaded?" and must not answer it in two vocabularies.
 */
const RUST_REASONS: string[] = (() => {
  const fn = CALP_RS.match(/fn calp_skip_reason\([\s\S]*?\n\}/);
  expect(fn, "calp_skip_reason moved or was renamed").toBeTruthy();
  const found = [...fn![0].matchAll(/=>\s*\{?\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  expect(found.length, "no reason literals parsed out of calp_skip_reason").toBeGreaterThan(0);
  return [...new Set(found)];
})();

describe("the pane names every skip reason the backend can report", () => {
  it("parses the Rust classifier's vocabulary", () => {
    // Sanity: the classifier must still distinguish the states the pane's
    // wording depends on. `notPinned` and `publisherChanged` in particular must
    // not be collapsed — one is "subscribe once", the other is "do not trust".
    expect(RUST_REASONS).toEqual(
      expect.arrayContaining(["unreachable", "notPinned", "publisherChanged", "badManifest", "appTooOld", "unknown"]),
    );
  });

  it("has a notice row for each one", () => {
    const table = PANE.match(/const WRITEBACK_SKIP_NOTICE[\s\S]*?\n\};/);
    expect(table, "WRITEBACK_SKIP_NOTICE moved or was renamed").toBeTruthy();
    const rows = [...table![0].matchAll(/^\s{2}([a-zA-Z]+):\s*\{/gm)].map((m) => m[1]);
    // `unknown` is deliberately absent: it is the catch-all, and the render path
    // has an explicit fallback for any reason with no row. Every NAMED reason
    // must have its own sentence.
    for (const reason of RUST_REASONS.filter((r) => r !== "unknown")) {
      expect(rows, `no WRITEBACK_SKIP_NOTICE row for reason '${reason}'`).toContain(reason);
    }
    // `deferred` is set by the open-path rebuild, not by the classifier.
    expect(rows).toContain("deferred");
  });

  it("an unrecognised reason still warns instead of rendering nothing", () => {
    // A skip record PROVES the rules are not loaded. Rendering nothing for a
    // reason this build has not heard of says the opposite.
    const flat = PANE.replace(/\s+/g, " ");
    expect(flat).toContain("const tone = notice?.tone ?? \"danger\"");
    expect(flat).toMatch(/were not loaded \('\$\{skip\.reason\}'\)/);
  });

  it("says the protections are not in force, not merely that something failed", () => {
    const flat = PANE.replace(/\s+/g, " ");
    expect(flat).toMatch(/are NOT in force/);
    expect(flat).toMatch(/Subscribe to it once to activate them/);
  });
});

describe("the Rust -> TS mirror of WritebackRebuildSkip", () => {
  it("declares the same fields, camelCased", () => {
    const rust = CALP_RS.match(/pub struct WritebackRebuildSkip \{([\s\S]*?)\n\}/);
    expect(rust, "WritebackRebuildSkip moved or was renamed").toBeTruthy();
    const rustFields = [...rust![1].matchAll(/^\s*pub ([a-z_]+):/gm)]
      .map((m) => m[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
      .sort();

    const ts = DIST_TS.match(/export interface WritebackRebuildSkip \{([\s\S]*?)\n\}/);
    expect(ts, "WritebackRebuildSkip mirror missing from @api/distribution").toBeTruthy();
    const tsFields = [...ts![1].matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();

    expect(tsFields).toEqual(rustFields);
  });

  it("the command the binding invokes is the command Rust registers", () => {
    expect(DIST_TS).toContain('invokeBackend("calp_get_writeback_rebuild_skips")');
    const LIB_RS = read("src-tauri/src/lib.rs");
    expect(LIB_RS).toContain("calp_commands::calp_get_writeback_rebuild_skips");
  });
});

describe("the deferred half of the open-path rebuild reaches the UI", () => {
  it("the shell bridges the Tauri event the worker emits", () => {
    // rebuild_writeback_index_deferring_http emits this AFTER the HTTP walk
    // lands. Without the bridge the regions are installed in the backend and
    // nothing on screen re-reads them.
    expect(CALP_RS).toContain('app.emit("distribution:writeback-index-changed"');
    expect(BOOTSTRAP).toContain('listenTauriEvent("distribution:writeback-index-changed"');
    expect(BOOTSTRAP).toContain("WRITEBACK_INDEX_CHANGED_EVENT");
  });

  it("the pane re-reads on it", () => {
    expect(PANE).toContain("onAppEvent(WRITEBACK_INDEX_CHANGED_EVENT, refresh)");
  });
});

// ---------------------------------------------------------------------------
// The SAME disclosure rule for the application's DATA MODEL.
//
// An application's BI connection is not stored in the subscriber's `.cala` — the
// model belongs to the publisher and travels in the `.calp` — so it is rebuilt on
// open from the local application cache under the same signature + pin + checksum
// gates a pull runs. When that cannot be done, the report still shows its
// last-pulled cells and the only other symptom is a pivot quietly reporting no
// connection: indistinguishable from an application that never had a data
// source. Exactly the state the writeback disclosure above exists to end.
// ---------------------------------------------------------------------------

describe("the pane names every application-connection skip reason", () => {
  it("has a notice row for each classifier reason", () => {
    const table = PANE.match(/const CONNECTION_SKIP_NOTICE[\s\S]*?\n\};/);
    expect(table, "CONNECTION_SKIP_NOTICE moved or was renamed").toBeTruthy();
    const rows = [...table![0].matchAll(/^\s{2}([a-zA-Z]+):\s*\{/gm)].map((m) => m[1]);
    for (const reason of RUST_REASONS.filter((r) => r !== "unknown")) {
      expect(rows, `no CONNECTION_SKIP_NOTICE row for reason '${reason}'`).toContain(reason);
    }
    // Set by the restore walk itself, not by the classifier: an HTTP workspace
    // exposes no local model artifact, so no connection can be built from it.
    expect(rows).toContain("unsupportedTransport");
  });

  it("an unrecognised reason still warns instead of rendering nothing", () => {
    const flat = PANE.replace(/\s+/g, " ");
    expect(flat).toMatch(/data model was not loaded \('\$\{skip\.reason\}'\)/);
  });

  it("says the report is not live, not merely that something failed", () => {
    const flat = PANE.replace(/\s+/g, " ");
    expect(flat).toMatch(/nothing is live|not connected to live data/);
  });
});

describe("the Rust -> TS mirror of ApplicationConnectionRestoreSkip", () => {
  it("declares the same fields, camelCased", () => {
    const rust = CALP_RS.match(/pub struct ApplicationConnectionRestoreSkip \{([\s\S]*?)\n\}/);
    expect(rust, "ApplicationConnectionRestoreSkip moved or was renamed").toBeTruthy();
    const rustFields = [...rust![1].matchAll(/^\s*pub ([a-z_]+):/gm)]
      .map((m) => m[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
      .sort();

    const ts = DIST_TS.match(/export interface ApplicationConnectionRestoreSkip \{([\s\S]*?)\n\}/);
    expect(ts, "ApplicationConnectionRestoreSkip mirror missing from @api/distribution").toBeTruthy();
    const tsFields = [...ts![1].matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();

    expect(tsFields).toEqual(rustFields);
  });

  it("the command the binding invokes is the command Rust registers", () => {
    expect(DIST_TS).toContain('invokeBackend("calp_get_application_connection_skips")');
    const LIB_RS = read("src-tauri/src/lib.rs");
    expect(LIB_RS).toContain("calp_commands::calp_get_application_connection_skips");
  });
});

describe("the application-connection restore actually runs on the open path", () => {
  it("open_file calls it, after the subscription ledger it reads is restored", () => {
    const PERSISTENCE = code(read("src-tauri/src/persistence.rs"));
    const restoreLedger = PERSISTENCE.indexOf("restore_distribution_user_files(&state, &mut workbook)");
    const restoreConns = PERSISTENCE.indexOf("restore_application_bi_connections(");
    expect(restoreLedger, "the subscription-ledger restore moved").toBeGreaterThan(-1);
    expect(
      restoreConns,
      "open_file no longer restores package BI connections, so a reopened subscribed " +
        "report has no path back to a live model",
    ).toBeGreaterThan(-1);
    expect(
      restoreConns,
      "the application-connection restore runs BEFORE the subscription ledger it reads",
    ).toBeGreaterThan(restoreLedger);
  });

  it("it re-verifies rather than taking the workbook's word", () => {
    // The restore reads a manifest for an application named by a FILE that can arrive
    // by email. RequirePinned is what stops that file from minting a publisher
    // pin; `load_verified_data_sources` is where the gate chain lives.
    expect(CALP_RS).toContain("calp::pull::load_verified_data_sources(");
    const PULL_RS = read("../core/calp/src/pull.rs");
    expect(PULL_RS).toContain("load_pinned_manifest_via(");
    expect(PULL_RS).toContain("verify_version_artifacts_via(registry, package_name, version, &manifest)");
  });
});
