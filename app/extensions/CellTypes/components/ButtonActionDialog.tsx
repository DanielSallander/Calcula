//! FILENAME: app/extensions/CellTypes/components/ButtonActionDialog.tsx
// PURPOSE: Dialog for configuring a button cell's action: run a registered
//          command or a workbook script (with optional function to call).
// CONTEXT: Opened by "Insert > Cell Type > Button" and the cell context menu.
//          The caller passes { onApply(action, label) } through dialog data.
//
//          PROVENANCE IS SHOWN BEFORE THE CHOICE IS MADE. A module that arrived
//          in a .calp is listed with its application, choosing it shows what
//          the button will actually do (run the published code, unchanged, only
//          once the application is approved), and "Function to call" is
//          withheld for it — `planStoredModuleRun` refuses that composition at
//          click time, and a field the planner will refuse is a field that
//          should not be offered. See extensions/_shared/lib/scriptModuleProvenance.ts.

import React, { useEffect, useMemo, useState } from "react";
import type { DialogProps } from "@api";
import { ExtensionRegistry } from "@api";
import { listWorkbookScripts, type ScriptSummary } from "../../../src/api/workbookScripts";
import {
  describeDistributedScriptChoice,
  describeWithheldFunctionField,
  isDistributedScriptEntry,
  scriptEntryApplication,
  scriptPickerLabel,
} from "../../_shared/lib/scriptModuleProvenance";
import type { ButtonAction } from "../types/button";

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600 };

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  fontSize: 13,
  border: "1px solid #c0c0c0",
  borderRadius: 3,
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 16,
};

const noteStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: "#5a4a00",
  background: "#fff8dc",
  border: "1px solid #e6d78a",
  borderRadius: 3,
  padding: "5px 8px",
};

export function ButtonActionDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
  const [kind, setKind] = useState<"command" | "script">("command");
  const [commandId, setCommandId] = useState("");
  const [scriptId, setScriptId] = useState("");
  const [functionName, setFunctionName] = useState("");
  const [label, setLabel] = useState("");
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);

  const commands = useMemo(
    () => (isOpen ? ExtensionRegistry.getAllCommands() : []),
    [isOpen]
  );

  useEffect(() => {
    if (!isOpen) return;
    setKind("command");
    setCommandId("");
    setScriptId("");
    setFunctionName("");
    setLabel("");
    listWorkbookScripts()
      .then(setScripts)
      .catch(() => setScripts([]));
  }, [isOpen]);

  if (!isOpen) return null;

  const canApply = kind === "command" ? commandId !== "" : scriptId !== "";

  // Derived from the LISTED row, which carries the `sourcePackage` stamp — the
  // one authority on whether this is the user's code or a publisher's.
  const selectedScript = scripts.find((s) => s.id === scriptId) ?? null;
  const selectedIsDistributed =
    selectedScript !== null && isDistributedScriptEntry(selectedScript);
  const provenanceNote = selectedScript ? describeDistributedScriptChoice(selectedScript) : null;
  const withheldNote = selectedScript ? describeWithheldFunctionField(selectedScript) : null;

  const chooseScript = (id: string) => {
    setScriptId(id);
    // A name typed for a local module must not ride along onto a distributed
    // one: the field is withheld for it, and the planner would refuse the run.
    const chosen = scripts.find((s) => s.id === id);
    if (chosen && isDistributedScriptEntry(chosen)) setFunctionName("");
  };

  const apply = () => {
    const action: ButtonAction =
      kind === "command"
        ? { kind: "command", commandId }
        : {
            kind: "script",
            scriptId,
            functionName: selectedIsDistributed ? undefined : functionName.trim() || undefined,
          };
    const onApply = data?.onApply as
      | ((action: ButtonAction, label: string) => void)
      | undefined;
    onApply?.(action, label.trim());
    onClose();
  };

  return (
    <div style={{ padding: 16, minWidth: 360 }}>
      <div style={fieldStyle}>
        <span style={labelStyle}>Button label</span>
        <input
          style={inputStyle}
          value={label}
          placeholder="Button"
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div style={fieldStyle}>
        <span style={labelStyle}>Action</span>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            checked={kind === "command"}
            onChange={() => setKind("command")}
          />{" "}
          Run a command
        </label>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            checked={kind === "script"}
            onChange={() => setKind("script")}
          />{" "}
          Run a workbook script
        </label>
      </div>

      {kind === "command" ? (
        <div style={fieldStyle}>
          <span style={labelStyle}>Command</span>
          <select
            style={inputStyle}
            value={commandId}
            onChange={(e) => setCommandId(e.target.value)}
          >
            <option value="">Select a command…</option>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.id}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div style={fieldStyle}>
            <span style={labelStyle}>Workbook script</span>
            <select
              style={inputStyle}
              value={scriptId}
              data-button-script-select=""
              onChange={(e) => chooseScript(e.target.value)}
            >
              <option value="">Select a script…</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {scriptPickerLabel(s)}
                </option>
              ))}
            </select>
            {provenanceNote && selectedScript ? (
              <span
                style={noteStyle}
                data-button-script-provenance={scriptEntryApplication(selectedScript) ?? ""}
              >
                {provenanceNote}
              </span>
            ) : null}
          </div>
          <div style={fieldStyle}>
            <span style={labelStyle}>Function to call (optional)</span>
            {withheldNote ? (
              <span style={noteStyle} data-button-function-withheld="">
                {withheldNote}
              </span>
            ) : (
              <input
                style={inputStyle}
                value={functionName}
                data-button-function-name=""
                placeholder="e.g. RunReport — empty runs the whole script"
                onChange={(e) => setFunctionName(e.target.value)}
              />
            )}
          </div>
        </>
      )}

      <div style={buttonRowStyle}>
        <button style={{ ...inputStyle, cursor: "pointer" }} onClick={onClose}>
          Cancel
        </button>
        <button
          style={{
            ...inputStyle,
            cursor: canApply ? "pointer" : "not-allowed",
            background: canApply ? "#217346" : "#9dbfae",
            color: "#ffffff",
            border: "1px solid transparent",
          }}
          disabled={!canApply}
          onClick={apply}
        >
          Insert Button
        </button>
      </div>
    </div>
  );
}
