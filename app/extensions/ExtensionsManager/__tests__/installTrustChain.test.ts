//! FILENAME: app/extensions/ExtensionsManager/__tests__/installTrustChain.test.ts
// PURPOSE: Guard the trust chain the install on-ramp depends on, end to end:
//          sidecar signature status -> capability ceiling -> worksheet function.
// CONTEXT: Wave F zeroes an untrusted sidecar's capability ceiling, which is the
//          ONLY thing standing between an unsigned add-in and `formula.udf` —
//          and therefore between it and code in the recalculation path of the
//          user's data. G0 shipped the signing + install path that makes a good
//          signature obtainable in the first place, so the zeroing stopped being
//          a theoretical default and became the live gate on a real feature.
//
//          Two of the three links are covered by behavioural tests elsewhere
//          (Rust: app/src-tauri/src/extension_install.rs produces the statuses;
//          TS: scriptHost/__tests__/extensionContributions.test.ts proves an
//          empty ceiling refuses a formula). The MIDDLE link — "which statuses
//          are trusted enough to honour the declared ceiling" — is a single
//          expression in the shell, so it is asserted here from the SOURCE TEXT
//          rather than reconstructed. That is deliberate: this extension may not
//          import the shell (Facade Rule), and a reconstruction would pass
//          happily while the real gate drifted.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { CONTRIBUTION_REQUIRED_CAPABILITY } from "@api/scriptHost/extensionProtocol";
import { TRUST_PRESENTATION, CONTRIBUTION_LABEL } from "../InstallAddInDialog";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const INSTALL_RS = read("src-tauri/src/extension_install.rs");

/**
 * The trust vocabulary Rust emits, READ OUT OF RUST rather than copied.
 *
 * It used to be a hand-maintained array here, and the cost of that showed up
 * immediately: the adversarial pass added two statuses (`codeUnverified`,
 * `trustUnavailable`) and a copied list would have gone on asserting that the
 * old five were complete while two unlabelled ones reached the UI. An
 * unlabelled security badge renders as an empty box, which reads as benign —
 * the worst possible failure for this particular string.
 */
function rustTrustStatuses(): string[] {
  const block = INSTALL_RS.match(
    /pub const EXTENSION_TRUST_STATUSES: &\[&str\] = &\[([\s\S]*?)\];/,
  );
  expect(block, "EXTENSION_TRUST_STATUSES moved or was renamed in extension_install.rs").toBeTruthy();
  const consts = [...block![1].matchAll(/TRUST_[A-Z_]+/g)].map((m) => m[0]);
  expect(consts.length, "EXTENSION_TRUST_STATUSES looks empty").toBeGreaterThan(4);
  return consts.map((name) => {
    const decl = INSTALL_RS.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`));
    expect(decl, `${name} has no string value in extension_install.rs`).toBeTruthy();
    return decl![1];
  });
}

const TRUST_STATUSES = rustTrustStatuses();

/** The statuses that are allowed to unlock the declared capability ceiling —
 *  also read out of Rust (`trust_grants_capabilities`), so the TS gate below is
 *  compared against the Rust rule rather than against a second copy of it. */
const TRUSTED_STATUSES = (() => {
  const fn = INSTALL_RS.match(
    /pub fn trust_grants_capabilities[\s\S]*?matches!\(status,([^)]*)\)/,
  );
  expect(fn, "trust_grants_capabilities moved or was renamed").toBeTruthy();
  return [...fn![1].matchAll(/TRUST_[A-Z_]+/g)].map((m) => {
    const decl = INSTALL_RS.match(new RegExp(`pub const ${m[0]}: &str = "([^"]+)"`));
    return decl![1];
  });
})();

/** Statuses an install must REFUSE. Everything Rust can emit that is not
 *  capability-trusted, minus `unsigned` (a legitimate, capability-less state a
 *  user is allowed to accept) and `publisherChanged` (a decision the user is
 *  allowed to make, behind its own separate question). */
const NON_INSTALLABLE = TRUST_STATUSES.filter(
  (s) => !TRUSTED_STATUSES.includes(s) && s !== "unsigned" && s !== "publisherChanged",
);

describe("install disclosure covers every trust state", () => {
  it("presents every status Rust can report", () => {
    for (const status of TRUST_STATUSES) {
      const row = TRUST_PRESENTATION[status];
      expect(row, `no presentation for trustStatus "${status}"`).toBeDefined();
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.blurb.length).toBeGreaterThan(0);
    }
  });

  it("refuses to install every status Calcula cannot vouch for", () => {
    // `unsigned` is a legitimate state (its capabilities are zeroed), and a
    // publisher change is a decision the user is allowed to make behind its own
    // question. Everything else means Calcula cannot state who wrote the code
    // that is about to run — there is no honest way to offer that.
    expect(NON_INSTALLABLE, "nothing is refused any more").not.toHaveLength(0);
    for (const status of NON_INSTALLABLE) {
      expect(TRUST_PRESENTATION[status].installable, status).toBe(false);
    }
    for (const status of TRUST_STATUSES.filter((s) => !NON_INSTALLABLE.includes(s))) {
      expect(TRUST_PRESENTATION[status].installable, status).toBe(true);
    }
  });

  it("tells the user plainly when a signature buys nothing", () => {
    expect(TRUST_PRESENTATION.unsigned.blurb).toMatch(/refused/i);
    expect(TRUST_PRESENTATION.unsigned.blurb).toMatch(/worksheet functions/i);
    // First contact must be phrased as a pin the user is about to CREATE.
    expect(TRUST_PRESENTATION.firstUse.blurb).toMatch(/pins this key/i);
    // A publisher change must name the alternative explanation out loud.
    expect(TRUST_PRESENTATION.publisherChanged.blurb).toMatch(/someone else/i);
    // A signature that authenticates only the DESCRIPTION must say so in those
    // terms — "signed" with no qualifier is the false impression to avoid.
    expect(TRUST_PRESENTATION.codeUnverified.blurb).toMatch(/code|program file/i);
    // "We could not check" must never be phrased as "we checked and it's fine".
    expect(TRUST_PRESENTATION.trustUnavailable.blurb).toMatch(/could not read/i);
  });

  it("gives the extensions list a badge for every status too", () => {
    // Same failure mode, different surface: the list is where a user looks at an
    // add-in they did NOT just install, so an unbadged status is invisible there
    // for the whole lifetime of the install rather than for one dialog.
    const listSrc = read("extensions/ExtensionsManager/ExtensionsListView.tsx");
    const badges = listSrc.match(/const SIGNATURE_BADGES[\s\S]*?\n};/);
    expect(badges, "SIGNATURE_BADGES moved or was renamed").toBeTruthy();
    for (const status of TRUST_STATUSES) {
      expect(badges![0], `no badge for trustStatus "${status}"`).toContain(`${status}:`);
    }
  });

  it("labels every contribution kind the Rust preview can return", () => {
    // Mirrors CONTRIBUTION_KEYS in app/src-tauri/src/extension_install.rs.
    for (const kind of [
      "formulas",
      "commands",
      "menuItems",
      "ribbonButtons",
      "keybindings",
      "cellStyles",
      "fileFormats",
    ]) {
      expect(CONTRIBUTION_LABEL[kind], `unlabelled contribution kind "${kind}"`).toBeTruthy();
    }
  });
});

describe("the capability ceiling is honoured for signed sidecars only", () => {
  const managerSrc = read("src/shell/registries/ExtensionManager.ts");

  it("treats exactly verified + firstUse as trusted, and nothing else", () => {
    // The single expression that decides whether a declared ceiling survives.
    const match = managerSrc.match(/const trustOk\s*=\s*([^;]+);/);
    expect(match, "the trustOk gate moved or was renamed").toBeTruthy();
    const expr = match![1];

    for (const status of TRUSTED_STATUSES) {
      expect(expr, `${status} must be trusted`).toContain(`"${status}"`);
    }
    for (const status of TRUST_STATUSES.filter((s) => !TRUSTED_STATUSES.includes(s))) {
      expect(expr, `${status} must NOT be trusted`).not.toContain(`"${status}"`);
    }
  });

  it("hands the worker an EMPTY ceiling when trust fails", () => {
    // `const ceiling = trustOk ? (...declared...) : [];`
    const match = managerSrc.match(/const ceiling\s*=\s*trustOk\s*\?([\s\S]*?);\n/);
    expect(match, "the ceiling assignment moved").toBeTruthy();
    const elseBranch = match![1].split(":").pop() ?? "";
    expect(elseBranch.replace(/\s/g, ""), "an untrusted sidecar must get []").toBe("[]");
  });

  it("still filters the declared list against the real capability vocabulary", () => {
    expect(managerSrc).toContain("CAPABILITY_ID_SET.has");
  });
});

describe("a worksheet function needs a capability, so it needs a signature", () => {
  const hostSrc = read("src/api/scriptHost/extensionWorkerHost.ts");

  it("requires formula.udf for the formula contribution kind", () => {
    // The closing link: an unsigned sidecar arrives with an EMPTY ceiling
    // (asserted above), and a formula cannot be admitted without this id in it.
    expect(CONTRIBUTION_REQUIRED_CAPABILITY.formula).toBe("formula.udf");
  });

  it("enforces it at REGISTRATION, against the authoritative ceiling", () => {
    // Registration-time (not call-time) is what keeps an unsigned add-in's
    // functions out of the catalog and out of IntelliSense entirely — and the
    // check must read the host-held ceiling, never anything from the worker.
    const admit = hostSrc.slice(
      hostSrc.indexOf("function admitContribution"),
      hostSrc.indexOf("function setupRegistration"),
    );
    expect(admit).toContain("CONTRIBUTION_REQUIRED_CAPABILITY[kind]");
    expect(admit).toContain("mw.handle.declaredCapabilities.has(required)");
    expect(admit).toContain("refuseContribution");
    // ...and admitContribution must gate setupRegistration, not merely exist.
    const setup = hostSrc.slice(hostSrc.indexOf("function setupRegistration"));
    expect(setup.slice(0, 900)).toContain("admitContribution(mw, reg)");
  });
});

describe("the install command is reached through the gated backend door", () => {
  it("never imports the raw invokeBackend passthrough", () => {
    const channel = read("extensions/ExtensionsManager/backendChannel.ts");
    expect(channel).toContain("createBackendChannel");
    expect(channel).not.toMatch(/import\s*\{[^}]*\binvokeBackend\b/);
    // The channel must be bound in activate(), or every call rejects.
    expect(read("extensions/ExtensionsManager/index.ts")).toContain(
      "extensionsBackend.set(context.invokeBackend)",
    );
  });

  it("only ever sends a path the user picked in a native dialog", () => {
    const dialog = read("extensions/ExtensionsManager/InstallAddInDialog.tsx");
    expect(dialog).toContain("@tauri-apps/plugin-dialog");
    expect(dialog).toContain("directory: true");
    // The install call must use the path state set from the picker result, and
    // the dialog must never build a path from anything else.
    expect(dialog).toContain("installAddIn(sourcePath");
    expect(dialog).not.toMatch(/sourcePath\s*=\s*["'`]/);
  });

  it("asks the publisher-change question separately from the install decision", () => {
    const dialog = read("extensions/ExtensionsManager/InstallAddInDialog.tsx");
    // acceptChange starts false, is only set by an explicit checkbox, and gates
    // the Install button when the publisher changed.
    expect(dialog).toContain("useState(false)");
    expect(dialog).toContain('needsChangeAck = report?.trustStatus === "publisherChanged"');
    expect(dialog).toContain("(!needsChangeAck || acceptChange)");
  });
});
