//! FILENAME: app/extensions/Controls/PropertiesPane/ButtonActionSection.tsx
// PURPOSE: The Properties pane's "Action" section for a BUTTON (Canvas contract
//          §3/§4.4): Power BI's button Action list as Calcula honours it --
//          Run code (OnSelect) / Go to page / Back / Clear all slicers -- plus
//          the destination page for "Go to page".
// CONTEXT: A declarative action is three control properties
//          (@api/buttonControlService `buttonActionProperties`), written here
//          in ONE sequence through the pane's own property door so the backend,
//          the metadata the pane shows and the floating store (the pane's
//          `controls:action-changed` event) move together.
//
//          ONE BUTTON, ONE THING. Choosing an action on a button that has code
//          (a non-empty OnSelect, or a macro link) ASKS first -- the code would
//          otherwise sit there, never running, looking like it does -- and on
//          consent removes the code BEFORE the action is written, so a failure
//          half-way leaves a button with neither rather than both. The question
//          is `confirmAsync` (awaited; it fails CLOSED, so a dialog that cannot
//          be shown is a refusal). A button holding an APPLICATION's code
//          (BUG-0257's held compartment) cannot be given an action here at
//          all: that code is replaced or removed through its own section,
//          which shows it first.
//
//          Not a PropertyDefinition row: the action is a CHOICE with a
//          dependent second field, not a free value, and a definition would
//          also put "action" in BUTTON_PROPERTIES, which the script-key census
//          (mediaHandles.test.ts) reads as a key scripts may write.

import React, { useEffect, useState } from "react";
import { getSheets } from "@api/lib";
import { confirmAsync } from "@api/dialogs";
import {
  BUTTON_ACTION_LABELS,
  MACRO_REF_PROPERTY,
  buttonActionProperties,
  readButtonAction,
  type ButtonAction,
  type ButtonActionKind,
} from "@api/buttonControlService";
import type { ControlPropertyValue } from "../lib/types";

const v = (token: string) => `var(${token})`;

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "5px 12px",
  gap: 3,
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: v("--text-secondary"),
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 7px",
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  fontSize: 12,
  fontFamily: v("--font-family-sans"),
  outline: "none",
  boxSizing: "border-box",
  backgroundColor: v("--bg-surface"),
  color: v("--text-primary"),
  cursor: "pointer",
};

const hintStyle: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.35,
  color: v("--text-secondary"),
};

/** The pane's option list: "" is "run the button's code", as before actions. */
const ACTION_OPTIONS: ReadonlyArray<{ value: "" | ButtonActionKind; label: string }> = [
  { value: "", label: "Run code" },
  { value: "navigate", label: "Go to page" },
  { value: "back", label: BUTTON_ACTION_LABELS.back },
  { value: "clearSlicers", label: BUTTON_ACTION_LABELS.clearSlicers },
];

/** A page the destination list offers. */
interface PageChoice {
  /** The value the destination select carries: the stable id, else the name. */
  key: string;
  sheetId?: string;
  name: string;
}

export interface ButtonActionSectionProps {
  /** The button's sheet: its own page is not a destination. */
  sheetIndex: number;
  /** The button's properties as the pane holds them. */
  properties: Record<string, ControlPropertyValue> | undefined;
  /** The button holds an application's code (the held compartment). */
  heldCode: boolean;
  /** Write these static properties, in order; rejects on the first refusal. */
  writeProperties: (entries: Array<[string, string]>) => Promise<void>;
}

/** The static text of a property, "" when absent or a formula. */
function staticText(properties: ButtonActionSectionProps["properties"], key: string): string {
  const p = properties?.[key];
  return p && p.valueType === "static" ? p.value : "";
}

export function ButtonActionSection({
  sheetIndex,
  properties,
  heldCode,
  writeProperties,
}: ButtonActionSectionProps): React.ReactElement {
  const [pages, setPages] = useState<PageChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const action = readButtonAction(properties);

  useEffect(() => {
    let alive = true;
    // Through a resolved promise, so even a SYNCHRONOUS failure of the read is
    // a rejection handled below and never an exception out of this effect
    // (which would take the whole Properties pane down with it).
    Promise.resolve()
      .then(() => getSheets())
      .then(({ sheets }) => {
        if (!alive) return;
        setPages(
          sheets
            .filter((s) => s.index !== sheetIndex && (s.visibility ?? "visible") === "visible")
            .map((s) => ({ key: s.sheetId ?? s.name, sheetId: s.sheetId, name: s.name })),
        );
      })
      .catch((err) => console.error("[Controls] Could not list the pages for the button's action:", err));
    return () => {
      alive = false;
    };
  }, [sheetIndex]);

  const hasCode =
    staticText(properties, "onSelect").length > 0 || staticText(properties, MACRO_REF_PROPERTY).length > 0;

  const write = async (next: ButtonAction | null, removeCode: boolean): Promise<void> => {
    const entries: Array<[string, string]> = [];
    if (removeCode) {
      // Code FIRST: a failure after this leaves a button with neither code nor
      // action, never both.
      if (staticText(properties, "onSelect").length > 0) entries.push(["onSelect", ""]);
      if (staticText(properties, MACRO_REF_PROPERTY).length > 0) entries.push([MACRO_REF_PROPERTY, ""]);
    }
    for (const [k, value] of Object.entries(buttonActionProperties(next))) entries.push([k, value]);
    setBusy(true);
    try {
      await writeProperties(entries);
    } finally {
      setBusy(false);
    }
  };

  const toAction = (kind: "" | ButtonActionKind, page?: PageChoice): ButtonAction | null => {
    switch (kind) {
      case "":
        return null;
      case "navigate":
        return page
          ? page.sheetId
            ? { kind: "navigate", sheetId: page.sheetId, sheetName: page.name }
            : { kind: "navigate", sheetName: page.name }
          : null;
      case "back":
        return { kind: "back" };
      case "clearSlicers":
        return { kind: "clearSlicers" };
    }
  };

  const onActionChange = async (kind: "" | ButtonActionKind): Promise<void> => {
    if (kind === (action?.kind ?? "")) return;
    const next = toAction(kind, pages[0]);
    if (kind === "navigate" && !next) return; // no other page to go to
    let removeCode = false;
    if (next && hasCode) {
      const ok = await confirmAsync(
        `This button runs code when it is clicked. A button does one thing: choosing ` +
          `"${ACTION_OPTIONS.find((o) => o.value === kind)?.label}" removes its code. ` +
          `Remove the code and use the action?`,
        { title: "Button action" },
      );
      if (!ok) return;
      removeCode = true;
    }
    await write(next, removeCode);
  };

  const onTargetChange = async (key: string): Promise<void> => {
    const page = pages.find((p) => p.key === key);
    if (!page) return;
    await write(toAction("navigate", page), false);
  };

  const currentTargetKey =
    action?.kind === "navigate"
      ? (pages.find((p) => (action.sheetId && p.sheetId === action.sheetId) || p.name === action.sheetName)?.key ??
        "")
      : "";

  return (
    <div data-testid="control-button-action-section">
      <div style={rowStyle}>
        <label style={labelStyle} htmlFor="control-button-action">
          Action
        </label>
        <select
          id="control-button-action"
          data-testid="control-button-action"
          style={selectStyle}
          value={action?.kind ?? ""}
          disabled={heldCode || busy}
          onChange={(e) => void onActionChange(e.target.value as "" | ButtonActionKind)}
        >
          {ACTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} disabled={o.value === "navigate" && pages.length === 0}>
              {o.label}
            </option>
          ))}
        </select>
        {heldCode ? (
          <div style={hintStyle}>
            This button holds code that came with an application. Replace or remove that code (below)
            before giving the button an action.
          </div>
        ) : action ? (
          <div style={hintStyle}>
            A click performs this action -- also on a published (read-only) report and with scripts
            turned off.
          </div>
        ) : null}
      </div>
      {action?.kind === "navigate" && (
        <div style={rowStyle}>
          <label style={labelStyle} htmlFor="control-button-action-target">
            Destination
          </label>
          <select
            id="control-button-action-target"
            data-testid="control-button-action-target"
            style={selectStyle}
            value={currentTargetKey}
            disabled={heldCode || busy}
            onChange={(e) => void onTargetChange(e.target.value)}
          >
            {currentTargetKey === "" && <option value="">{action.sheetName} (not found)</option>}
            {pages.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
