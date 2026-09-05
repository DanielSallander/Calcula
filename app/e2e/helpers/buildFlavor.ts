//! FILENAME: app/e2e/helpers/buildFlavor.ts
// PURPOSE: Answer ONE question for any spec that measures a SHIPPED security
//          policy: is the app under test serving its document from the tauri
//          asset protocol (which attaches `security.csp` to the response) or
//          from the Vite dev server (which attaches nothing)?
// CONTEXT: `e2e/tests/csp-srcdoc-bridge.spec.ts` measures whether the `ui.html`
//          srcdoc bridge executes under the app's CSP. That measurement is only
//          worth reading in a build where a CSP is actually delivered. On
//          Windows desktop `cargo tauri dev` -- which is what
//          `e2e/global-setup.ts` launches -- points the webview straight at
//          `build.devUrl`, because tauri 2.9.5 compiles the dev-server proxy out
//          on desktop (`PROXY_DEV_SERVER = cfg!(all(dev, mobile))`,
//          `src/manager/webview.rs:40`) and the ONLY code that sets a
//          `Content-Security-Policy` header is the `tauri://` asset protocol
//          (`src/protocol/tauri.rs:213-214`). `app/index.html` carries no CSP
//          `<meta>` and Vite sends no header, so `devCsp` is dead text there.
//
//          The verdict therefore has to be taken from the URL the document is
//          ACTUALLY at, at run time, rather than from an env var somebody has to
//          remember: an env var can be set against a dev build (the noise this
//          gate exists to remove) and forgotten against a bundled one (a silent
//          no-run, which is worse).
//
//          THE ONE RULE THIS FILE MUST NEVER BREAK: an unrecognised URL is
//          MEANINGFUL, i.e. the spec runs. A classifier that guesses "probably
//          dev" on something it does not know would silence the measurement in
//          exactly the build nobody anticipated -- and a silenced security
//          measurement reads identically to a passing one.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the main document came from, as far as the URL can tell. */
export type DocumentSource = "dev-server" | "asset-protocol" | "unrecognised";

export interface DocumentSourceVerdict {
  source: DocumentSource;
  /**
   * May a CSP measurement taken in this build be believed? False ONLY for the
   * dev server, which is known to deliver no policy at all on this platform.
   */
  cspVerdictMeaningful: boolean;
  /** Did the URL match the `build.devUrl` this repo is configured with? */
  matchesConfiguredDevUrl: boolean;
  /** One sentence, fit to be a skip reason or a failure message. */
  reason: string;
}

/** Hosts that are the loopback interface under some spelling. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The bundled document is served by the tauri asset protocol, reached as
 * `http://tauri.localhost` on Windows and spelled `tauri://localhost` on
 * macOS/Linux. Either spelling means the response came out of
 * `src/protocol/tauri.rs`, which is the branch that attaches the CSP header.
 */
function isAssetProtocol(parsed: URL, host: string): boolean {
  if (host === "tauri.localhost") return true;
  return parsed.protocol === "tauri:" && LOOPBACK_HOSTS.has(host);
}

/**
 * Classify the document URL of the app under test.
 *
 * `devUrl` is the repo's configured `build.devUrl` and is used ONLY to enrich
 * the verdict (`matchesConfiguredDevUrl`) and its sentence -- the dev-server
 * arm keys on the loopback host itself, so a Vite that fell back to another
 * port is still recognised rather than being handed to the unrecognised arm.
 */
export function classifyDocumentSource(
  documentUrl: string,
  devUrl: string | null,
): DocumentSourceVerdict {
  let parsed: URL | null = null;
  try {
    parsed = new URL(documentUrl);
  } catch {
    parsed = null;
  }

  const configuredOrigin = (() => {
    if (!devUrl) return null;
    try {
      return new URL(devUrl).origin;
    } catch {
      return null;
    }
  })();

  if (!parsed) {
    return {
      source: "unrecognised",
      cspVerdictMeaningful: true,
      matchesConfiguredDevUrl: false,
      reason:
        `The document URL ${JSON.stringify(documentUrl)} did not parse, so this build could ` +
        "not be identified. The measurement runs anyway: an unknown build is measured, never " +
        "excused.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  const matchesConfiguredDevUrl = configuredOrigin !== null && parsed.origin === configuredOrigin;

  // The asset protocol is tested FIRST, because `tauri://localhost` puts a
  // loopback name in `hostname` too and would otherwise read as the dev server.
  if (isAssetProtocol(parsed, host)) {
    return {
      source: "asset-protocol",
      cspVerdictMeaningful: true,
      matchesConfiguredDevUrl: false,
      reason:
        `Served from the tauri asset protocol (${parsed.origin}), which is the one code path ` +
        "that attaches the configured security.csp to the response.",
    };
  }

  if (LOOPBACK_HOSTS.has(host) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return {
      source: "dev-server",
      cspVerdictMeaningful: false,
      matchesConfiguredDevUrl,
      reason:
        `The app under test is served by the dev server at ${parsed.origin}` +
        (matchesConfiguredDevUrl ? " (the configured build.devUrl)" : "") +
        ", so NO Content-Security-Policy is in force: on Windows desktop `tauri dev` navigates " +
        "straight to devUrl and never touches the tauri:// asset protocol, the only place tauri " +
        "2.9.5 sets the CSP header (src/protocol/tauri.rs:213), because PROXY_DEV_SERVER = " +
        "cfg!(all(dev, mobile)) (src/manager/webview.rs:40). Any verdict taken here would be " +
        "about an unprotected build. Re-run against a BUNDLED build: `npm run e2e:platform:manual` " +
        "with an installed/`tauri build` binary already running.",
    };
  }

  return {
    source: "unrecognised",
    cspVerdictMeaningful: true,
    matchesConfiguredDevUrl,
    reason:
      `The document is at ${parsed.origin}, which is neither the tauri asset protocol nor a ` +
      "loopback dev server. The measurement runs anyway: an unknown build is measured, never " +
      "excused.",
  };
}

/**
 * The `build.devUrl` this repo configures, read from `src-tauri/tauri.conf.json`
 * rather than typed here -- a hardcoded port is how a gate starts describing a
 * dev server the repo stopped launching.
 *
 * Returns null when the field is absent, which the classifier handles: the
 * dev-server arm does not depend on it.
 */
export function readConfiguredDevUrl(appRoot?: string): string | null {
  const root = appRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const raw = readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8");
    const conf = JSON.parse(raw) as { build?: { devUrl?: string } };
    return conf.build?.devUrl ?? null;
  } catch {
    return null;
  }
}
