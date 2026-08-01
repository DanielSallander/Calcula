//! FILENAME: app/extensions/ExtensionsManager/AddInsRibbonSection.tsx
// PURPOSE: The HOST-RENDERED ribbon surface for sandboxed third-party add-ins.
// CONTEXT: A sandboxed extension cannot ship a React component — that is the
//          whole point of the worker realm. So it ships a DESCRIPTOR
//          (id/label/icon token/group/order/command) and this trusted built-in
//          paints it: "host-owned chrome, extension-owned content"
//          (docs/design/third-party-addin-authoring.md §3 O3).
//
//          Three properties are load-bearing and must not be softened:
//            1. NO CALLBACK CROSSES. A button carries a command id, which the
//               host executes through the CommandRegistry. There is no click
//               handler from the sandbox, so an add-in cannot capture input or
//               run code the user did not trigger.
//            2. NO MARKUP CROSSES. `icon` is a TOKEN looked up in the host's
//               own RibbonIcon set; an unknown token falls back to a generic
//               glyph. An add-in can never inject an image, an SVG or a style.
//            3. ATTRIBUTION IS HOST-DRAWN. Every group is headed by the
//               extension's name (from the authoritative manifest), so a
//               sandboxed surface can never pass itself off as part of the app.

import React, { useSyncExternalStore } from "react";
import { CommandRegistry, RibbonIcon } from "@api";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  listExtensionRibbonButtons,
  subscribeToExtensionContributions,
} from "@api/scriptHost/extensionWorkerHost";

type IconToken = keyof typeof RibbonIcon;

/** Generic fallback: a puzzle piece, for an unknown or absent icon token. */
function GenericAddInIcon(): React.ReactElement {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function renderIcon(token: string | undefined): React.ReactElement {
  if (token && Object.prototype.hasOwnProperty.call(RibbonIcon, token)) {
    const Icon = RibbonIcon[token as IconToken];
    return <Icon size={16} />;
  }
  return <GenericAddInIcon />;
}

interface ButtonRow {
  extId: string;
  extName: string;
  group: string;
  id: string;
  label: string;
  tooltip?: string;
  icon?: string;
  order: number;
  commandId: string;
}

/** Group the flat contribution list by extension, then by the extension's own
 *  group label. Ordering is (extension name, group label, order, label) — all
 *  host-decided, so one add-in cannot push itself in front of another with a
 *  large negative order. */
function collectRows(): Array<{ heading: string; buttons: ButtonRow[] }> {
  const rows: ButtonRow[] = listExtensionRibbonButtons().map((c) => ({
    extId: c.extId,
    extName: c.extName,
    group: (c.button.group ?? "").trim().slice(0, 48) || "Commands",
    id: c.button.id,
    label: (c.button.label ?? c.button.id).slice(0, 48),
    tooltip: c.button.tooltip?.slice(0, 240),
    icon: c.button.icon,
    order: typeof c.button.order === "number" && Number.isFinite(c.button.order) ? c.button.order : 0,
    commandId: c.commandId,
  }));

  const byHeading = new Map<string, ButtonRow[]>();
  for (const row of rows) {
    const heading = `${row.extName} - ${row.group}`;
    const list = byHeading.get(heading);
    if (list) list.push(row);
    else byHeading.set(heading, [row]);
  }
  return [...byHeading.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([heading, buttons]) => ({
      heading,
      buttons: buttons.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
    }));
}

/** External store over the contribution registry: the snapshot is memoized so
 *  useSyncExternalStore sees a stable reference between notifications. */
type Snapshot = ReturnType<typeof collectRows>;
let snapshot: Snapshot | null = null;

const contributionStore = {
  subscribe(onChange: () => void): () => void {
    return subscribeToExtensionContributions(() => {
      snapshot = null;
      onChange();
    });
  },
  getSnapshot(): Snapshot {
    if (snapshot === null) snapshot = collectRows();
    return snapshot;
  },
};

export function AddInsRibbonSection(_props: PanelSectionProps): React.ReactElement {
  const groups = useSyncExternalStore(
    contributionStore.subscribe,
    contributionStore.getSnapshot,
    contributionStore.getSnapshot,
  );

  if (groups.length === 0) {
    return (
      <div style={styles.empty}>
        No add-in has contributed a ribbon button. Installed add-ins appear here
        automatically.
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {groups.map((group) => (
        <div key={group.heading} style={styles.group}>
          <div style={styles.buttons}>
            {group.buttons.map((b) => (
              <button
                key={`${b.extId}:${b.id}`}
                type="button"
                style={styles.button}
                title={b.tooltip ? `${b.tooltip} (${b.extName})` : `${b.label} (${b.extName})`}
                onClick={() => {
                  // The ONLY thing a click does: run the extension's own
                  // registered command. Errors are contained here so a broken
                  // add-in cannot take the ribbon down with it.
                  void Promise.resolve(CommandRegistry.execute(b.commandId)).catch((e) =>
                    console.error(`[add-ins] command ${b.commandId} failed:`, e),
                  );
                }}
              >
                {renderIcon(b.icon)}
                <span style={styles.buttonLabel}>{b.label}</span>
              </button>
            ))}
          </div>
          {/* Host-drawn attribution: never overridable by the add-in. */}
          <div style={styles.heading}>{group.heading}</div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "row",
    alignItems: "stretch",
    gap: 8,
  },
  group: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: 2,
    padding: "0 6px",
    borderRight: "1px solid var(--border-subtle, #e0e0e0)",
  },
  buttons: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 2,
  },
  button: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    minWidth: 48,
    maxWidth: 96,
    padding: "4px 6px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 4,
    cursor: "pointer",
    color: "var(--text-primary, #333)",
    font: "inherit",
    fontSize: 11,
  },
  buttonLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 84,
  },
  heading: {
    fontSize: 10,
    color: "var(--text-secondary, #777)",
    textAlign: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 200,
  },
  empty: {
    fontSize: 11,
    color: "var(--text-secondary, #888)",
    padding: "6px 10px",
    maxWidth: 320,
  },
};
