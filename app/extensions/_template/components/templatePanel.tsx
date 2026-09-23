//! FILENAME: app/extensions/_template/components/templatePanel.tsx
// PURPOSE: The template's PanelDefinition — the one object index.ts hands to
//          `context.ui.panels.register(...)`.
// CONTEXT: Kept apart from MyRibbonSections.tsx so that file exports only
//          components (React Fast Refresh can then hot-swap them), and so the
//          DECLARATION of a panel — ids, icons, how each section behaves in
//          the band — reads in one place, separate from what the sections draw.

import { RibbonIcon } from "@api/ribbonIcons";
import type { PanelDefinition } from "@api/uiTypes";
import { ICON_SIZE_MD, ICON_SIZE_SM } from "@api/layout";
import { TemplateActionsSection, TemplateOptionsSection } from "./MyRibbonSections";

/** The panel id. Section ids below are prefixed with it, which also makes the
 *  launcher test ids `section-launcher-<sectionId>` unique across the app. */
export const TEMPLATE_PANEL_ID = "my-org.my-extension.panel";

/**
 * The panel as the shell sees it. Built by a function (not a module constant)
 * so each registration gets fresh icon elements.
 *
 * - `icon` (panel): a RibbonIcon at 20 (ICON_SIZE_SM) — the activity-bar icon
 *   when the panel lives in the sidebar, and the launcher icon of a fully
 *   demoted single-section panel.
 * - `icon` (section): a RibbonIcon at 24 (ICON_SIZE_MD) — shown on the
 *   section's LAUNCHER when it demotes and in its sidebar HEADER. Always give
 *   one; without it the shell falls back to a generic group glyph.
 * - `ribbonPresentation: "inline"`: the Actions section is known to be
 *   exactly 61px (heroes), so the shell skips the height probe. The Options
 *   section keeps the default "auto": the shell measures it and demotes it to
 *   a launcher if it ever grows past the box — a safety net, not a layout.
 * - `collapsePriority`: when the band is too NARROW, lower demotes first.
 *   Options goes before Actions, so the Run hero stays visible longest.
 * - `flyoutWidth`: the launcher flyout's width when the section demotes
 *   (clamped to 240-480).
 * - NO `ribbonColor`: its presence is what marks a tab CONTEXTUAL (shown only
 *   while something is selected, like Chart Design). A contextual tab passes a
 *   token with a light fallback, e.g. "var(--tab-accent-chart, #1d5fd0)", so a
 *   skin can retint it; see docs/design/ribbon-design-system.md.
 */
export function buildTemplatePanelDefinition(): PanelDefinition {
  return {
    id: TEMPLATE_PANEL_ID,
    title: "My Extension",
    icon: <RibbonIcon.Lightning size={ICON_SIZE_SM} />,
    sections: [
      {
        id: `${TEMPLATE_PANEL_ID}.actions`,
        label: "Actions",
        icon: <RibbonIcon.Play size={ICON_SIZE_MD} />,
        component: TemplateActionsSection,
        ribbonPresentation: "inline",
        collapsePriority: 20,
      },
      {
        id: `${TEMPLATE_PANEL_ID}.options`,
        label: "Options",
        icon: <RibbonIcon.Settings size={ICON_SIZE_MD} />,
        component: TemplateOptionsSection,
        collapsePriority: 10,
        flyoutWidth: 280,
      },
    ],
    // The user can move it to the sidebar (right-click the tab); this is
    // only where it starts.
    defaultPlacement: "ribbon",
    // Lower = further left among the ribbon tabs.
    ribbonOrder: 80,
  };
}
