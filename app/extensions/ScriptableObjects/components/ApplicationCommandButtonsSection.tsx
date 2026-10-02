//! FILENAME: app/extensions/ScriptableObjects/components/ApplicationCommandButtonsSection.tsx
// PURPOSE: "Code in This File" lists the button cells that came with an
//          application and run a Calcula COMMAND (plan_M8 S3, BUG-0257 phase 5)
//          -- each button, the command, the application, and whether a click
//          on it runs the command here.
// CONTEXT: Code must be visible where it lives. A command is Calcula's own
//          code, but WHEN it runs is the application's to decide once
//          approved, so the buttons that can start one are listed beside the
//          application's other button code. A row says, by the same two rules
//          a click applies:
//            * never runs here -- the command's LIVE registration does not opt
//              in (`distributableTrigger`), another registration has replaced
//              it, or it is not registered (`judgeApplicationCommand`, the
//              page's half);
//            * approved / waiting / elsewhere -- the approval Rust's command
//              gate asks, under `button-commands:<application>` at the sha256
//              of the command id, over the approvals that count on THIS
//              computer (a record sealed elsewhere counts for nothing here).
//          Rust's list (`DISTRIBUTABLE_BUTTON_COMMANDS`) is held equal to the
//          flagged registrations by a drift test, and the admission removes any
//          other command on the way in, so a listed button whose command opts
//          in is one Rust's list allows too.

import React from "react";
import { ExtensionRegistry } from "@api/extensions";
import {
  buttonCommandConsentKey,
  describeApplicationCommandRefusal,
  judgeApplicationCommand,
  type ApplicationCellCommand,
} from "@api/heldButtonCode";
import type { ConsentReport } from "@api/distributedConsent";

const sectionStyle: React.CSSProperties = {
  margin: "8px 4px",
  padding: "6px 8px",
  border: "1px solid #d8d8d8",
  borderRadius: 4,
  background: "#fafafa",
};

const headerStyle: React.CSSProperties = { fontWeight: 600, fontSize: 11, marginBottom: 4 };
const introStyle: React.CSSProperties = { fontSize: 11, color: "#555", lineHeight: 1.4, marginBottom: 6 };
const rowStyle: React.CSSProperties = { fontSize: 11, padding: "3px 0", borderTop: "1px solid #eee" };

/** Where an application's command button stands, on this computer. */
export type ApplicationCommandState = "approved" | "waiting" | "elsewhere" | "neverRuns" | "unknown";

/** The registry as this section reads it (the real @api facade in production). */
export interface CommandRegistryLookup {
  getCommand(commandId: string): { name?: string; distributableTrigger?: unknown } | undefined;
  isCommandShadowed(commandId: string): boolean;
}

/**
 * The state of one application command button, and the sentence that says it.
 * Exported for the unit tier.
 */
export function describeApplicationCommandState(
  entry: ApplicationCellCommand,
  report: ConsentReport | null,
  registry: CommandRegistryLookup = ExtensionRegistry,
): { state: ApplicationCommandState; text: string } {
  const refusal = judgeApplicationCommand(
    registry.getCommand(entry.commandId),
    registry.isCommandShadowed(entry.commandId),
  );
  if (refusal !== null) {
    return { state: "neverRuns", text: `Never runs here: ${describeApplicationCommandRefusal(refusal)}.` };
  }
  if (report === null) {
    return { state: "unknown", text: "Whether you approved it could not be read." };
  }
  const key = buttonCommandConsentKey(entry.application);
  const approved = report.consents.some(
    (record) =>
      record.packageName === key &&
      record.scripts.some((s) => s.id === entry.commandId && s.sourceHash === entry.commandHash),
  );
  if (approved) {
    return { state: "approved", text: "Approved on this computer: runs the command when its button is clicked." };
  }
  const elsewhere = report.ignored.some(
    (i) => i.packageName === key && (i.reason === "otherComputer" || i.reason === "unsealed"),
  );
  if (elsewhere) {
    return {
      state: "elsewhere",
      text:
        "Waiting for your approval: an approval from another computer does not count here. " +
        "It runs when clicked once you approve the application's command buttons on this one.",
    };
  }
  return {
    state: "waiting",
    text: "Waiting for your approval: runs when clicked, after you approve the application's command buttons.",
  };
}

/** The one line naming a button and what it runs. Exported for the unit tier. */
export function describeApplicationCommandButton(
  entry: ApplicationCellCommand,
  registry: CommandRegistryLookup = ExtensionRegistry,
): string {
  const live = registry.getCommand(entry.commandId);
  const name = typeof live?.name === "string" && live.name !== "" ? `"${live.name}" (${entry.commandId})` : entry.commandId;
  const caption = entry.caption ? ` "${entry.caption}"` : "";
  return `${entry.cell}${caption} (button cell) -- runs the Calcula command ${name}, for '${entry.application}'`;
}

export function ApplicationCommandButtonsSection({
  entries,
  error,
  report = null,
}: {
  entries: ApplicationCellCommand[];
  error: string | null;
  /** The approvals as Rust lists them (null: they could not be read). */
  report?: ConsentReport | null;
}): React.ReactElement | null {
  if (!error && entries.length === 0) return null;
  return (
    <div style={sectionStyle} data-testid="application-command-buttons-section">
      <div style={headerStyle}>Buttons from an application that run a Calcula command ({entries.length})</div>
      {error ? (
        <div style={{ ...introStyle, color: "#B00020" }}>Could not read the command buttons: {error}</div>
      ) : (
        <>
          <div style={introStyle}>
            These button cells came with an application and run one of Calcula&apos;s own commands. The
            command is Calcula&apos;s code; the application&apos;s button decides when it runs, and only
            after you approve the application&apos;s command buttons on this computer.
          </div>
          {entries.map((entry) => {
            const state = describeApplicationCommandState(entry, report);
            return (
              <div key={entry.cell} style={rowStyle} data-application-command-button={entry.cell}>
                <div>{describeApplicationCommandButton(entry)}</div>
                <div
                  style={{ color: state.state === "approved" ? "#3A6B3A" : "#7a4a00" }}
                  data-application-command-state={state.state}
                >
                  {state.text}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
