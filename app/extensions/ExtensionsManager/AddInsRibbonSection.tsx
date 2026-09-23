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
//               own RibbonIcon set; an unknown token falls back to the host's
//               generic add-in glyph. An add-in can never inject an image, an
//               SVG or a style. Labels and tooltips are rendered as text.
//            3. ATTRIBUTION IS HOST-DRAWN. Every group is headed by the
//               extension's name (from the authoritative manifest), so a
//               sandboxed surface can never pass itself off as part of the app.
//
//          Calcula Clusters shape. Each contribution GROUP is its own
//          PanelSection (buildAddInsSections), so add-in groups are measured and
//          width-demoted one at a time like any built-in cluster. The section's
//          LABEL is the attribution heading ("<extension name> - <group>") and
//          the section declares captionMode "always", so the shell's cluster
//          caption draws it in the band and keeps drawing it when the user
//          hides ribbon labels — hiding labels must never strip the only
//          attribution on a sandboxed button. Where the shell draws NO header
//          for the section (a sidebar panel with a single section, and a
//          single-section panel demoted to the panel-titled launcher — both
//          only when exactly one group exists), the section draws the heading
//          itself; with several groups the sidebar headers and launcher labels
//          carry it, and drawing it again would only duplicate it.
//
//          Buttons are CommandButton heroes, so in the band every group is ONE
//          TALL ROW of 61px heroes (the fill rule, @api/layout tokens.ts) and a
//          sandboxed add-in inherits the built-in look without writing CSS.

import React, { useSyncExternalStore } from "react";
import { CommandRegistry } from "@api/commands";
import { RibbonIcon } from "@api/ribbonIcons";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  FONT_FAMILY,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_MD,
  LT,
  CommandButton,
  useSurfaceLayout,
} from "@api/layout";
import {
  listExtensionRibbonButtons,
  subscribeToExtensionContributions,
} from "@api/scriptHost/extensionWorkerHost";

type IconToken = keyof typeof RibbonIcon;

/**
 * The host's generic add-in glyph: the fallback for an unknown or absent icon
 * token, the Add-ins tab icon and the Extensions rail icon. It IS
 * `RibbonIcon.AddIn` (the puzzle piece), so it follows the one duotone set;
 * the wrapper only carries `data-addin-glyph`, which marks "the fallback was
 * used" for tests without a second drawing to keep in step.
 */
export function AddInGlyph({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <span data-addin-glyph="" style={{ display: "inline-flex", flex: "none" }} aria-hidden>
      <RibbonIcon.AddIn size={size} />
    </span>
  );
}

/** Resolve an add-in's icon TOKEN against the host's own icon set. */
export function resolveAddInIcon(token: string | undefined, size: number): React.ReactElement {
  if (token && Object.prototype.hasOwnProperty.call(RibbonIcon, token)) {
    const Icon = RibbonIcon[token as IconToken];
    return <Icon size={size} />;
  }
  return <AddInGlyph size={size} />;
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

/** One contribution group: the host-drawn attribution heading and its buttons. */
export interface AddInGroup {
  heading: string;
  buttons: ButtonRow[];
}

/** Group the flat contribution list by extension, then by the extension's own
 *  group label. Ordering is (extension name, group label, order, label) — all
 *  host-decided, so one add-in cannot push itself in front of another with a
 *  large negative order. Always computed fresh from the registry. */
export function computeAddInGroups(): AddInGroup[] {
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

// ============================================================================
// External store over the contribution registry
// ============================================================================

/** The memoized snapshot, so useSyncExternalStore sees a stable reference
 *  between notifications. */
let snapshot: AddInGroup[] | null = null;
let invalidationInstalled = false;

/**
 * Drop the memo on EVERY registry change, not only while a section is
 * mounted. Without this, a change that lands while the Add-ins tab is not on
 * screen leaves the memo stale, and the section mounts showing the old
 * buttons until the next change.
 */
function ensureInvalidation(): void {
  if (invalidationInstalled) return;
  invalidationInstalled = true;
  subscribeToExtensionContributions(() => {
    snapshot = null;
  });
}

const contributionStore = {
  subscribe(onChange: () => void): () => void {
    ensureInvalidation();
    return subscribeToExtensionContributions(() => {
      snapshot = null;
      onChange();
    });
  },
  getSnapshot(): AddInGroup[] {
    ensureInvalidation();
    if (snapshot === null) snapshot = computeAddInGroups();
    return snapshot;
  },
};

// ============================================================================
// Section component (one per contribution group)
// ============================================================================

const attributionStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: "13px",
  color: LT.textSecondary,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

function runAddInCommand(commandId: string): void {
  // The ONLY thing a click does: run the extension's own registered command.
  // Errors are contained here so a broken add-in cannot take the ribbon down
  // with it.
  try {
    void Promise.resolve(CommandRegistry.execute(commandId)).catch((e) =>
      console.error(`[add-ins] command ${commandId} failed:`, e),
    );
  } catch (e) {
    console.error(`[add-ins] command ${commandId} failed:`, e);
  }
}

/** The buttons of ONE contribution group, painted by the host. */
export function AddInGroupSection({ heading }: { heading: string }): React.ReactElement | null {
  const groups = useSyncExternalStore(
    contributionStore.subscribe,
    contributionStore.getSnapshot,
    contributionStore.getSnapshot,
  );
  const layout = useSurfaceLayout();
  const group = groups.find((g) => g.heading === heading);
  // The group vanished between a registry change and the panel's
  // re-registration: render nothing rather than an empty cluster.
  if (!group) return null;

  const buttons = (
    <ActionRow gap={GAP_XS}>
      {group.buttons.map((b) => (
        <CommandButton
          key={`${b.extId}:${b.id}`}
          icon={resolveAddInIcon(b.icon, HERO_ICON_SIZE)}
          label={b.label}
          tooltip={b.tooltip ? `${b.tooltip} (${b.extName})` : `${b.label} (${b.extName})`}
          data-testid={`addin-button-${b.extId}:${b.id}`}
          onClick={() => runAddInCommand(b.commandId)}
        />
      ))}
    </ActionRow>
  );

  // Band: the cluster caption (section label, captionMode "always") is the
  // attribution. Elsewhere, draw it only where the shell draws no header.
  const drawOwnHeading = layout.container !== "band" && groups.length === 1;
  if (!drawOwnHeading) return buttons;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: GAP_XS, minWidth: 0 }}>
      {/* Host-drawn attribution: never overridable by the add-in. */}
      <div style={attributionStyle} data-testid="addin-attribution" title={group.heading}>
        {group.heading}
      </div>
      {buttons}
    </div>
  );
}

/** One component identity per heading, so re-registering the panel with the
 *  same groups never remounts a group's buttons. */
const sectionComponents = new Map<string, React.ComponentType<PanelSectionProps>>();

export function addInGroupSection(heading: string): React.ComponentType<PanelSectionProps> {
  const existing = sectionComponents.get(heading);
  if (existing) return existing;
  const Component = (_props: PanelSectionProps): React.ReactElement | null => (
    <AddInGroupSection heading={heading} />
  );
  Component.displayName = `AddInGroupSection(${heading})`;
  sectionComponents.set(heading, Component);
  return Component;
}

/** A section id derived from the heading: deterministic and unique (headings
 *  are unique by construction, and encodeURIComponent is injective). */
export function addInSectionId(heading: string): string {
  return `extensions.addins.${encodeURIComponent(heading)}`;
}

/** The Add-ins panel's sections: one per contribution group. */
export function buildAddInsSections(groups: AddInGroup[] = computeAddInGroups()): PanelSection[] {
  return groups.map((g) => ({
    id: addInSectionId(g.heading),
    // Host-drawn attribution: the cluster caption / sidebar header / launcher
    // label, from the authoritative manifest name — never from the add-in.
    label: g.heading,
    // Resolved against the host's own icon set, like every button icon.
    icon: resolveAddInIcon(g.buttons[0]?.icon, ICON_SIZE_MD),
    component: addInGroupSection(g.heading),
    // Heroes are 61px — exactly the band's content box — so no height probe;
    // width is still measured, so a narrow band demotes groups one at a time.
    ribbonPresentation: "inline" as const,
    // Attribution survives the "hide ribbon labels" preference.
    captionMode: "always" as const,
  }));
}

/** Change key for the panel registration: the set of groups and the icons
 *  their sections show. Buttons changing WITHIN a group re-render through the
 *  store instead and need no re-registration. */
export function addInSectionsKey(groups: AddInGroup[]): string | null {
  if (groups.length === 0) return null;
  return JSON.stringify(groups.map((g) => [g.heading, g.buttons[0]?.icon ?? ""]));
}
