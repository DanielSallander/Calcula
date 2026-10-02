// FILENAME: app/extensions/Collaboration/components/WithheldContentList.tsx
// PURPOSE: Name every item a push leaves in this workbook because it is not the
//          application's (BUG-0261).
// CONTEXT: A working copy holds the author's own content and whatever its other
//          subscriptions brought in, beside the application's. The backend push
//          filter (app/src-tauri/src/calp_push_scope.rs) keeps only the author's
//          own and this application's, and returns what it withheld BY NAME in
//          `PublishReport.withheld`. Before that list existed, a withheld item
//          reached only the log -- to the person pushing, a silent drop.
//
//          Two kinds of "not the application's", said differently on purpose:
//            * another application's code is withheld so it is never signed
//              under your key -- the notice names whose it is;
//            * your own content the application never had stays with you --
//              nothing is deleted, it simply does not ship.
//
//          INCLUDE IN APPLICATION (M4). Your own new macro, notebook or name can
//          be ADDED to the application from the push dialog: the row offers
//          "Show code" and an "Include in application" tick that stays disabled
//          until the code -- the exact text Rust hashed -- has been on screen.
//          The controls come from `IncludeInApplicationContext`, which only the
//          push dialog provides; everywhere else (the Application Explorer's
//          preview) the list stays read-only.

import React, { createContext, useContext, useState } from "react";
import type { WithheldContent, WithheldKind } from "@api";

/** What the push dialog lets a row do with an includable item. */
export interface IncludeControls {
  /** Ticked for the code the item holds NOW. */
  isIncluded(item: WithheldContent): boolean;
  /** Ticked for code other than what it holds now (it changed since it was read). */
  isTickedForOtherCode(item: WithheldContent): boolean;
  /** Its code, at this hash, has been on screen. */
  isReviewed(item: WithheldContent): boolean;
  /** The code has just been put on screen. */
  review(item: WithheldContent): void;
  /** Tick or untick; a tick before review is refused by the owner. */
  setIncluded(item: WithheldContent, include: boolean): void;
}

/** Provided by the push dialog only. `null` = read-only list. */
export const IncludeInApplicationContext = createContext<IncludeControls | null>(null);

/** The code an item would ship, as blocks to show: a notebook's cells one by
 *  one (its `code` is the JSON array of cell sources Rust hashed), anything
 *  else as one block. */
export function codeBlocks(item: WithheldContent): string[] {
  const code = item.code ?? "";
  if (item.kind === "notebook") {
    try {
      const cells: unknown = JSON.parse(code);
      if (Array.isArray(cells) && cells.every((c) => typeof c === "string")) return cells as string[];
    } catch {
      // Not the array Rust sends: show the text as it is.
    }
  }
  return [code];
}

const codeStyle: React.CSSProperties = {
  margin: "2px 0 4px 20px",
  padding: "4px 6px",
  maxHeight: 180,
  overflow: "auto",
  fontSize: "11px",
  fontFamily: "Consolas, monospace",
  whiteSpace: "pre-wrap",
  border: "1px solid var(--border-default)",
  borderRadius: 3,
  background: "var(--panel-bg)",
};

/**
 * "Show code" and the "Include in application" tick for one includable item.
 * The tick is DISABLED until the code has been shown: nothing goes out under
 * the author's key that was not on screen (the ButtonCodeReview rule).
 * Renders nothing outside the push dialog, or for an item Rust did not offer.
 */
export function IncludeControl({
  item,
  scope = "",
}: {
  item: WithheldContent;
  /** Prefixes the test ids when the same item is offered in a second place. */
  scope?: string;
}): React.ReactElement | null {
  const include = useContext(IncludeInApplicationContext);
  const [open, setOpen] = useState(false);
  if (!include || item.includable !== true || !item.contentHash) return null;
  const reviewed = include.isReviewed(item);
  const ticked = include.isIncluded(item);
  const stale = include.isTickedForOtherCode(item);
  const testKey = `${scope}${item.kind}-${item.id}`;
  return (
    <div data-testid={`include-${testKey}`} style={{ margin: "0 0 2px 20px" }}>
      <button
        data-testid={`include-show-${testKey}`}
        style={{ fontSize: "11px", marginRight: 8 }}
        onClick={() => {
          if (!open) include.review(item);
          setOpen(!open);
        }}
      >
        {open ? "Hide code" : "Show code"}
      </button>
      <label
        style={{ fontSize: "11px", opacity: reviewed ? 1 : 0.6 }}
        title={reviewed ? undefined : "Read the code first: press Show code."}
      >
        <input
          type="checkbox"
          data-testid={`include-tick-${testKey}`}
          checked={ticked}
          disabled={!reviewed}
          onChange={(e) => include.setIncluded(item, e.target.checked)}
        />{" "}
        Include in application
      </label>
      {stale && (
        <span data-testid={`include-stale-${testKey}`} style={{ fontSize: "11px", color: "#c5221f", marginLeft: 8 }}>
          It changed since you read it -- read it again before ticking.
        </span>
      )}
      {!reviewed && !ticked && (
        <span style={{ fontSize: "11px", opacity: 0.65, marginLeft: 8 }}>
          It would be published under your key, so read it first.
        </span>
      )}
      {item.detail && (
        <div data-testid={`include-detail-${testKey}`} style={{ fontSize: "11px", color: "#a05a00" }}>
          {item.detail}
        </div>
      )}
      {open && (
        <div data-testid={`include-code-${testKey}`}>
          {codeBlocks(item).map((block, i, all) => (
            <pre key={i} style={codeStyle}>
              {all.length > 1 ? `// Cell ${i + 1}\n${block}` : block}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What this push ADDS to the application from your own content ("Include in
 * application"), by name. Inside the push dialog each row keeps its code and
 * tick (to untick it); elsewhere it is read-only. Renders nothing when empty.
 */
export function AddedToApplicationList({
  items,
}: {
  items: readonly WithheldContent[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div data-testid="added-to-application">
      <div style={{ ...groupLabelStyle, color: "#1e7e34" }}>
        Added to the application — published under your key ({items.length})
      </div>
      {items.map((item) => (
        <div key={`${item.kind}-${item.id}`}>
          <div style={rowStyle} title={item.id}>
            <span style={{ color: "#1e7e34" }}>{"+"}</span>
            <span>{describeWithheld(item)}</span>
          </div>
          <IncludeControl item={item} />
        </div>
      ))}
    </div>
  );
}

/** One label per Rust `WithheldKind` variant (drift-tested against the Rust
 *  enum in pushWithheldDisclosure.test.tsx). */
export const WITHHELD_KIND_LABEL: Record<WithheldKind, string> = {
  objectScript: "Object script",
  moduleScript: "Script",
  customFunction: "Custom function",
  notebook: "Notebook",
  paneControl: "Pane control",
  namedRange: "Name",
};

/** One withheld item as a sentence fragment, e.g. `Object script 'Refresh'`. */
export function describeWithheld(item: WithheldContent): string {
  const label = WITHHELD_KIND_LABEL[item.kind] ?? item.kind;
  const name = item.name || item.id;
  if (item.reason === "otherApplication") {
    return item.owner
      ? `${label} '${name}' — from application '${item.owner}'`
      : `${label} '${name}' — from another application`;
  }
  return `${label} '${name}'`;
}

const groupLabelStyle: React.CSSProperties = {
  fontWeight: 600,
  opacity: 0.75,
  margin: "6px 0 2px 0",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "1px 0 1px 8px",
};
const mutedStyle: React.CSSProperties = { opacity: 0.65 };

/**
 * The withheld list, grouped by why. Renders nothing when the push withheld
 * nothing, so callers can mount it unconditionally.
 */
export function WithheldContentList({
  items,
}: {
  items: readonly WithheldContent[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  const foreign = items.filter((i) => i.reason === "otherApplication");
  const yours = items.filter((i) => i.reason !== "otherApplication");
  return (
    <div data-testid="withheld-content">
      <div style={{ ...groupLabelStyle, color: "#b8860b" }}>
        Not published — stays in this workbook ({items.length})
      </div>
      {foreign.length > 0 && (
        <div data-testid="withheld-other-applications">
          <div style={{ ...rowStyle, ...mutedStyle }}>
            Another application's code. It came in through a subscription, and
            publishing it here would sign that application's code under your key.
          </div>
          {foreign.map((item) => (
            <div key={`${item.kind}-${item.id}`} style={rowStyle} title={item.id}>
              <span style={{ color: "#b8860b" }}>{"⚠"}</span>
              <span>{describeWithheld(item)}</span>
            </div>
          ))}
        </div>
      )}
      {yours.length > 0 && (
        <div data-testid="withheld-yours">
          <div style={{ ...rowStyle, ...mutedStyle }}>
            Yours, and not part of the application. Nothing is deleted; it just
            does not ship.
          </div>
          {yours.map((item) => (
            <div key={`${item.kind}-${item.id}`}>
              <div style={rowStyle} title={item.id}>
                <span style={mutedStyle}>{"•"}</span>
                <span>{describeWithheld(item)}</span>
              </div>
              <IncludeControl item={item} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
