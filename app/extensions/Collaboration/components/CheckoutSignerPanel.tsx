// FILENAME: app/extensions/Collaboration/components/CheckoutSignerPanel.tsx
// PURPOSE: What the Checkout dialog shows after a version opens: who signed it,
//          on what authority, whether it is this computer's key, and the trust
//          status (BUG-0262).
// CONTEXT: The dialog used to close the moment the checkout returned and throw
//          the whole response away (`void result`) — trust status included. A
//          developer then edited, and re-signed with their own key, code whose
//          author they were never shown.
//
//          The backend now REFUSES a signer the application does not authorise
//          (anchored at its first version, failing closed), so nothing here is a
//          gate. It is disclosure, and two lines of it are deliberately careful:
//
//          * "your key" is DISPLAY ONLY. A version signed with your key can hold
//            a colleague's work after a merge or a co-publisher's push, so the
//            panel says what the fact means and nothing more — it never reads
//            as "safe to run".
//          * The trust status is a per-status TABLE with a row for every state
//            Rust can emit, never a ternary. A status that fell through to a
//            friendly default is how a security state gets mislabelled
//            (calpTrustPresentation.test.ts tells that history).
//
//          And one line about what THIS COMPUTER remembers (the developer
//          anchor): the creator it recorded just now, or the one it has
//          remembered since an earlier checkout, push or publish. Same rule:
//          a table with a row per anchor state Rust emits.

import React from "react";
import type {
  CalpTrustStatus,
  CheckoutAnchorInfo,
  CheckoutAnchorStatus,
  CheckoutResponse,
  DeveloperAnchoredBy,
} from "@api";
import { ButtonActionsNotice } from "./ButtonActionsNotice";

const OK = "#137333";
const WARN = "#a05a00";
const DANGER = "#c5221f";

/**
 * One row per trust state. A checkout verifies but NEVER records trust
 * (`PinPolicy::VerifyOnly`), so in practice only `verified`, `trustedDelegate`,
 * `notPinned` and `notPinnedNameConflict` arrive — the rest are still here so an
 * unexpected one is described honestly rather than falling to a default.
 */
export const CHECKOUT_TRUST: Record<CalpTrustStatus, { label: string; blurb: string; color: string }> = {
  verified: {
    label: "this computer already trusts this publisher",
    color: OK,
    blurb:
      "This computer subscribes to this application from this workspace, and the version is " +
      "signed by the same key it agreed to trust then.",
  },
  trustedDelegate: {
    label: "a co-publisher of the publisher this computer trusts",
    color: OK,
    blurb:
      "This computer trusts this application's publisher from this workspace, and the version " +
      "is signed by a co-publisher that publisher authorised.",
  },
  firstUse: {
    label: "trusted just now",
    color: WARN,
    blurb:
      "This publisher key was just recorded as trusted. Opening an application for editing " +
      "never records trust itself, so something else did — check Collaboration > Manage " +
      "Subscriptions.",
  },
  firstUseKnownPublisher: {
    label: "trusted just now — publisher already known",
    color: WARN,
    blurb:
      "This key was just recorded as trusted for this workspace, and was already trusted for " +
      "this application name from another one. Opening for editing does not record trust, so " +
      "something else did.",
  },
  firstUseAcceptedNameConflict: {
    label: "trusted despite a name conflict",
    color: DANGER,
    blurb:
      "Another workspace holds this application name under a DIFFERENT publisher key, and " +
      "that was accepted. Make sure this is the application you meant to edit.",
  },
  notPinned: {
    label: "not trusted on this computer",
    color: WARN,
    blurb:
      "Nobody on this computer subscribes to this application, so no publisher key has been " +
      "agreed to here — opening for editing deliberately does not record one. What WAS checked " +
      "is above: the version is signed, and its signer is an authorised publisher of this " +
      "application. Compare the key with the one your colleague gave you.",
  },
  notPinnedNameConflict: {
    label: "NAME CONFLICT — another workspace's publisher owns this name here",
    color: DANGER,
    blurb:
      "This application name is trusted on this computer from a DIFFERENT workspace, under a " +
      "DIFFERENT publisher key. The version you opened is signed by an authorised publisher " +
      "of the application in THIS workspace — but two workspaces claiming one name is what a " +
      "hijack looks like. Check that this is the application you meant to edit before you push.",
  },
};

const TRUST_FALLBACK = {
  label: "unrecognised trust state",
  color: DANGER,
  blurb:
    "Calcula does not recognise the trust state reported for this version. Do not push from " +
    "this working copy until you know why.",
};

/** How the remembered creator came to be remembered. One row per Rust
 *  `AnchoredBy` wire value. */
export const ANCHORED_BY: Record<DeveloperAnchoredBy, string> = {
  checkout: "when it was opened for editing here",
  publish: "when it was published or pushed from here",
  publisherList: "when who may publish it was changed from here",
};

type AnchorLine = { text: string; blurb: string; color: string };

/**
 * One row per developer-anchor state Rust emits (`CheckoutAnchorInfo::from_status`).
 * A checkout RECORDS on first contact, so it shows `firstContact` or `matches`;
 * `notAnchored` is what a passive read (the merge's head) reports, and is here
 * so it reads honestly wherever it appears.
 */
export const CHECKOUT_ANCHOR: Record<
  CheckoutAnchorStatus,
  (anchor: CheckoutAnchorInfo, rootFingerprint: string) => AnchorLine
> = {
  firstContact: (_anchor, rootFingerprint) => ({
    text:
      `First time on this computer: the creator key (${rootFingerprint}) is remembered from ` +
      "now on; a checkout naming a different creator will be refused.",
    blurb:
      "This computer had never opened this application from this workspace, so it has nothing " +
      "to compare the creator with yet. Compare the key with the one your colleague gave you: a " +
      "first version planted in the workspace would be remembered just as readily.",
    color: WARN,
  }),
  matches: (anchor) => ({
    text:
      `Matches the creator this computer first saw on ${anchor.anchoredAt.slice(0, 10) || "an earlier day"} ` +
      `(${ANCHORED_BY[anchor.anchoredBy as DeveloperAnchoredBy] ?? "how, it did not record"}).`,
    blurb:
      "The first version of an application can never change, so a workspace that named a " +
      "different creator would be refused here, naming both keys.",
    color: OK,
  }),
  notAnchored: () => ({
    text: "This computer does not remember who created this application yet.",
    blurb:
      "Nothing was recorded by this read. Opening the application for editing or pushing to it " +
      "records its creator.",
    color: WARN,
  }),
};

const ANCHOR_FALLBACK: AnchorLine = {
  text: "Calcula does not recognise what this computer reports about the application's creator.",
  blurb: "Do not push from this working copy until you know why.",
  color: DANGER,
};

/** The authority line: root, or a co-publisher the root lists. */
function authorityLine(signer: CheckoutResponse["signer"]): string {
  const root = `${signer.rootName || "the publisher who created it"} (key ${signer.rootFingerprint})`;
  switch (signer.role) {
    case "root":
      return "Authorised: the publisher who created this application.";
    case "coPublisher":
      return signer.listedAs
        ? `Authorised: a co-publisher that ${root} lists as "${signer.listedAs}".`
        : `Authorised: a co-publisher that ${root} lists.`;
    default:
      // Exhaustive over the wire type; a new role must be decided here.
      return `Authorised by ${root}.`;
  }
}

/**
 * The private-sheets notice (phase 3 of BUG-0257): `names` are the sheets the
 * working copy holds beside the application, as Rust's run gate counts them.
 * Pure, for tests and callers. Empty when there are none.
 */
export function describePrivateSheets(names: readonly string[]): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? `, +${names.length - 3} more` : "";
  const n = names.length;
  return (
    `${n} of your own sheet${n === 1 ? "" : "s"} (${shown}${more}) ${n === 1 ? "sits" : "sit"} ` +
    "beside the application, so its macros and object scripts will not run here: code from " +
    "an application can read every sheet, and what it writes into the application's sheets " +
    "goes out with your next push. Move them to another workbook, or open the application " +
    "in a new workbook."
  );
}

export interface CheckoutSignerPanelProps {
  result: CheckoutResponse;
  /**
   * The remedy for private sheets: open this application for editing again in a
   * new, empty workbook (`checkoutIntoNewWorkbook`, which asks before closing a
   * modified workbook and fails closed). Absent = the button is not offered.
   */
  onOpenInNewWorkbook?: () => void;
  /** Disables the remedy while something is in flight. */
  busy?: boolean;
}

export function CheckoutSignerPanel({ result, onOpenInNewWorkbook, busy }: CheckoutSignerPanelProps) {
  const { signer } = result;
  const privateSheets = result.privateSheets ?? [];
  const trust = CHECKOUT_TRUST[result.trustStatus] ?? TRUST_FALLBACK;
  const describeAnchor = signer.anchor ? CHECKOUT_ANCHOR[signer.anchor.status] : undefined;
  const anchor = describeAnchor
    ? describeAnchor(signer.anchor, signer.rootFingerprint)
    : ANCHOR_FALLBACK;
  const box: React.CSSProperties = {
    border: "1px solid var(--border-default)",
    borderRadius: "4px",
    padding: "8px 10px",
    marginBottom: "10px",
    lineHeight: 1.45,
  };
  const small: React.CSSProperties = { fontSize: "11px", color: "var(--text-secondary)" };

  return (
    <div data-testid="checkout-result">
      <div style={{ fontWeight: 600, marginBottom: "4px" }}>
        Opened {result.packageName} v{result.version} for editing
      </div>
      <div style={{ ...small, marginBottom: "10px" }}>
        {result.sheetsMaterialized} sheet{result.sheetsMaterialized === 1 ? "" : "s"} and{" "}
        {result.scriptsMaterialized} script{result.scriptsMaterialized === 1 ? "" : "s"} were
        added to this workbook.
      </div>

      <div style={box} data-testid="checkout-signer">
        <div style={{ ...small, fontWeight: 600, marginBottom: "2px" }}>Signed by</div>
        <div>
          <span style={{ fontWeight: 600 }} data-testid="checkout-signer-name">
            {signer.name || "an unnamed publisher"}
          </span>
          {signer.isYourKey && (
            <span
              data-testid="checkout-signer-yours"
              style={{
                marginLeft: 6,
                fontSize: "11px",
                padding: "0 5px",
                borderRadius: 8,
                background: "#e8f0fe",
                color: "#1a5fb4",
              }}
            >
              your key
            </span>
          )}
        </div>
        <div style={small}>
          key{" "}
          <span
            data-testid="checkout-signer-fingerprint"
            title={signer.key}
            style={{ fontFamily: "Consolas, monospace" }}
          >
            {signer.fingerprint}
          </span>
        </div>
        <div style={{ ...small, marginTop: "4px" }} data-testid="checkout-signer-authority">
          {authorityLine(signer)}
        </div>
        {signer.isYourKey && (
          <div style={{ ...small, marginTop: "4px" }}>
            Signed with the publisher key on this computer. That says who signed this version,
            not who wrote every change in it: a merge or a co-publisher&rsquo;s push can put
            someone else&rsquo;s work into a version signed with your key.
          </div>
        )}
      </div>

      <div style={box} data-testid="checkout-trust">
        <div style={{ ...small, fontWeight: 600, marginBottom: "2px" }}>Trust on this computer</div>
        <div style={{ color: trust.color, fontWeight: 600 }} data-testid="checkout-trust-label">
          {trust.label}
        </div>
        <div style={small}>{trust.blurb}</div>
      </div>

      <div style={box} data-testid="checkout-anchor">
        <div style={{ ...small, fontWeight: 600, marginBottom: "2px" }}>
          Creator remembered on this computer
        </div>
        <div style={{ color: anchor.color, fontWeight: 600 }} data-testid="checkout-anchor-line">
          {anchor.text}
        </div>
        <div style={small}>{anchor.blurb}</div>
      </div>

      {/* PHASE 3 OF BUG-0257: the working-copy private-sheet rule, said where
          the developer lands -- not first discovered as a refused click. The
          list is the run gate's own (Rust `private_sheets`). */}
      {privateSheets.length > 0 && (
        <div style={{ ...box, color: WARN }} data-testid="checkout-private-sheets">
          <div style={{ ...small, fontWeight: 600, marginBottom: "2px" }}>
            Application code in this workbook
          </div>
          <div>{describePrivateSheets(privateSheets)}</div>
          {onOpenInNewWorkbook && (
            <button
              data-testid="checkout-private-sheets-new-workbook"
              onClick={onOpenInNewWorkbook}
              disabled={busy === true}
              style={{ marginTop: "6px", whiteSpace: "nowrap" }}
            >
              Open it in a new workbook
            </button>
          )}
        </div>
      )}

      {/* BUG-0257: the application's button code is HELD, and it travels with
          the application: since phase 4 a button's own inline code runs through
          the Rust button door (`run_control_action`) once the approval screen
          has shown its exact bytes -- in a working copy too, behind the same
          private-sheet rule as its macros -- and a macro link runs the
          application's macro after the same approval. It used to say inline
          code "does not run in this working copy", which an approved click now
          contradicts. The one thing the admission may have cleared is said, not
          hidden. */}
      {(result.buttonCodeHeld ?? 0) > 0 && (
        <div style={box} data-testid="checkout-button-code-held">
          <div style={{ ...small, fontWeight: 600, marginBottom: "2px" }}>Button code</div>
          <div>
            {result.buttonCodeHeld} button code slot{result.buttonCodeHeld === 1 ? "" : "s"} came
            with this application and stay{result.buttonCodeHeld === 1 ? "s" : ""} the
            application&rsquo;s: a button runs its code, or the application&rsquo;s macro it links,
            only after you approve the application&rsquo;s code, which the approval screen shows.
            Your next push publishes {result.buttonCodeHeld === 1 ? "it" : "them"} unchanged,
            after checking against this signed version. The Properties pane shows the code, and
            &ldquo;Make this my own&rdquo; there makes a button&rsquo;s code yours.
          </div>
        </div>
      )}
      {/* BUG-0260: a button CELL's action that runs a macro the application did
          not bring in, or a command that is not on Calcula's list of commands
          such buttons may run (plan_M8), is held the same way -- and listed. */}
      <ButtonActionsNotice
        actions={result.buttonActionsHeld}
        mode="held"
        testId="checkout-button-actions-held"
      />
      {(result.oversizedValuesCleared ?? 0) > 0 && (
        <div style={{ ...box, color: WARN }} data-testid="checkout-oversized-cleared">
          {result.oversizedValuesCleared} control value
          {result.oversizedValuesCleared === 1 ? " was" : "s were"} cleared on the way in because{" "}
          {result.oversizedValuesCleared === 1 ? "it was" : "they were"} over the 64 KiB limit every
          workbook applies. If one was a button&rsquo;s code, a push refuses to publish the emptied
          button as the application&rsquo;s and names it.
        </div>
      )}
    </div>
  );
}
