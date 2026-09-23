//! FILENAME: app/extensions/_template/components/MyRibbonSections.tsx
// PURPOSE: Example ribbon tab / sidebar panel built ONLY from @api/layout
//          primitives: a hero section and a two-row options section.
// USAGE:   templatePanel.tsx declares the panel around these two sections and
//          index.ts registers it through `context.ui.panels.register(...)` —
//          the same call the built-in Animation and Add-ins panels make. Copy
//          both files and replace the two sections with your own.
// CONTEXT: THE DESIGN SYSTEM IN ONE PAGE (full version:
//          docs/design/ribbon-design-system.md).
//
//          1. YOU WRITE NO CSS AND NO COLOURS. Every control below comes from
//             "@api/layout" and paints with theme tokens, so this panel follows
//             Light, Dark, Calcula Soft, Calcula Contrast, a company skin and
//             High contrast without a line of code. The hex ban in
//             app/eslint.boundaries.js covers this folder; a colour literal
//             here fails `npm run lint:boundaries`.
//
//          2. ONE JSX TREE, THREE SURFACES. The shell renders a section in the
//             ribbon band, in a launcher flyout (when the band is too narrow)
//             or in the sidebar (when the user moves the panel). The
//             primitives read the surface from context and re-lay themselves
//             out: a CommandButton is a 61px hero in the band and a 28px
//             button in the sidebar; a ControlGrid is two stacked rows in the
//             band and a wrapping toolbar row in the sidebar. Never branch on
//             `placement` to lay out — compose primitives instead.
//
//          3. THE FILL RULE (app/src/api/layout/tokens.ts). In the band every
//             section sits in a rounded cluster card whose content box is
//             exactly 61px tall:
//
//               band 100 - padding 4+4 = 92 - caption 15 = card 77
//               card 77 - padding 8 on ALL FOUR sides      = content 61
//
//             Your section must FILL that 61 in exactly one of two ways:
//
//               ONE TALL ROW   61           CommandButton heroes, Tiles, or a
//                                           Segmented of 61px controls
//               TWO ROWS       28 + 5 + 28  two rows of 28px controls with
//                                           ROW_GAP (5) between them — what
//                                           ControlGrid does by default
//
//             Never one short row alone (a 28px row floating in a 61px box
//             reads as crammed and empty at once — the owner's verdict on the
//             first draft), and never three rows (3 x 28 does not fit, so
//             the shell demotes the section to a launcher). A short control
//             BESIDE a tall one is fine: the rule is about the section's box.
//
//          4. THE CONTROL GRAMMAR. Commands -> CommandButton / Button / Menu.
//             A value from a list -> Dropdown. On/off -> Checkbox (part of a
//             set of options), Switch (takes effect at once) or ToggleButton
//             (a formatting-style toggle). One of a few -> SegmentedChoice.
//             Every control is NAMED: an icon-only control carries its name as
//             `label`/aria-label and shows it in a Tooltip; a control whose
//             text is visible gets a tooltip only when it teaches something
//             (what it does, or its shortcut via `commandId`).
//
//          5. ICONS come from the one RibbonIcon set (@api/ribbonIcons) at the
//             size the slot wants: HERO_ICON_SIZE (30) in a hero,
//             ICON_SIZE_SM (20) in a 28px control, ICON_SIZE_MD (24) as a
//             section icon (launcher + sidebar header), ICON_SIZE_SM (20) as
//             the panel icon. docs/design/ICONS.md has the vocabulary.

import React, { useSyncExternalStore } from "react";
import { CommandRegistry } from "@api/commands";
import { RibbonIcon } from "@api/ribbonIcons";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  Checkbox,
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  Dropdown,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  SegmentedChoice,
  type DropdownOption,
  type SegmentedChoiceOption,
} from "@api/layout";
import {
  getTemplateOptions,
  resetTemplateOptions,
  setTemplateOptions,
  subscribeTemplateOptions,
  type TemplateOptions,
  type TemplatePrecision,
  type TemplateScope,
} from "../lib/templateOptions";

// ============================================================================
// Ids
// ============================================================================

/** The command the Run hero executes (registered in index.ts). An action that
 *  is a COMMAND, rather than a function the button calls directly, is also
 *  reachable from a keybinding, a menu item or another extension — and the
 *  hero's tooltip can show the live shortcut through `commandId`. */
export const TEMPLATE_RUN_COMMAND = "template.run";

// ============================================================================
// Shared state hook
// ============================================================================

/** Every mounted copy of a section (band, flyout, sidebar) reads the same
 *  store; see lib/templateOptions.ts for why it is not component state. */
function useTemplateOptions(): Readonly<TemplateOptions> {
  return useSyncExternalStore(subscribeTemplateOptions, getTemplateOptions, getTemplateOptions);
}

// ============================================================================
// Section 1 — Actions: ONE TALL ROW of heroes
// ============================================================================

function runTemplateCommand(): void {
  // A command handler can throw or reject; contain it here so a failing run
  // never takes the ribbon down with it.
  CommandRegistry.execute(TEMPLATE_RUN_COMMAND).catch((err: unknown) => {
    console.error(`[_template] ${TEMPLATE_RUN_COMMAND} failed:`, err);
  });
}

/**
 * FILL RULE, form 1: ONE TALL ROW. A CommandButton in the band is a 61px hero
 * (a 34px icon slot over an 11px label), so a row of them fills the cluster's
 * content box exactly. Pass the icon at HERO_ICON_SIZE; outside the band the
 * same button becomes a 28px button and fits the icon to 20px itself.
 */
export function TemplateActionsSection(_props: PanelSectionProps): React.ReactElement {
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Play size={HERO_ICON_SIZE} />}
        label="Run"
        // A hero's label is visible, so a tooltip is only worth showing when
        // it adds something: what the command does, and (via commandId) the
        // keyboard shortcut the user bound to it, resolved live.
        tooltip="Run with the current options"
        commandId={TEMPLATE_RUN_COMMAND}
        data-testid="template-run"
        onClick={runTemplateCommand}
      />
      <CommandButton
        icon={<RibbonIcon.Refresh size={HERO_ICON_SIZE} />}
        label="Reset"
        tooltip="Put every option back to its default"
        data-testid="template-reset"
        onClick={resetTemplateOptions}
      />
    </ActionRow>
  );
}

// ============================================================================
// Section 2 — Options: TWO ROWS of 28px controls
// ============================================================================

/** One of a few -> SegmentedChoice. Icon-only keeps the row short; each
 *  option's `label` becomes its accessible name and its tooltip, and
 *  `tooltip` (when given) replaces the label in the tooltip only. */
const SCOPE_OPTIONS: ReadonlyArray<SegmentedChoiceOption<TemplateScope>> = [
  {
    value: "selection",
    label: "Selection",
    icon: <RibbonIcon.Pointer size={ICON_SIZE_SM} />,
    tooltip: "Apply to the selected cells",
    testId: "template-scope-selection",
  },
  {
    value: "sheet",
    label: "Sheet",
    icon: <RibbonIcon.Table size={ICON_SIZE_SM} />,
    tooltip: "Apply to the whole active sheet",
    testId: "template-scope-sheet",
  },
  {
    value: "workbook",
    label: "Workbook",
    icon: <RibbonIcon.Folder size={ICON_SIZE_SM} />,
    tooltip: "Apply to every sheet in the workbook",
    testId: "template-scope-workbook",
  },
];

/** A value from a list -> Dropdown (never a native <select> in the ribbon: it
 *  cannot follow the skin once open and it clips inside the band). The labels
 *  are short on purpose: the trigger is 104px wide in the band (the Dropdown
 *  default); in the sidebar it fills the row. */
const PRECISION_OPTIONS: ReadonlyArray<DropdownOption<TemplatePrecision>> = [
  { value: 0, label: "0 decimals" },
  { value: 1, label: "1 decimal" },
  { value: 2, label: "2 decimals" },
];

/**
 * FILL RULE, form 2: TWO ROWS. ControlGrid stacks its children into two band
 * rows with ROW_GAP (5px) between them, so two rows of 28px controls fill the
 * 61px box exactly: 28 + 5 + 28. ControlGridBreak says where row 1 ends; in
 * the sidebar the break is ignored and the grid flows as one wrapping row.
 *
 * Every control here is 28px tall in the band: the SegmentedChoice pill (its
 * border is an inset shadow, so it adds no height), the Dropdown trigger and
 * each Checkbox row. Do not mix in a 24px control — the rows would no longer
 * add up to 61.
 */
export function TemplateOptionsSection(_props: PanelSectionProps): React.ReactElement {
  const options = useTemplateOptions();
  return (
    <ControlGrid>
      {/* Row 1: one of a few, then a value from a list. */}
      <SegmentedChoice<TemplateScope>
        ariaLabel="Scope"
        iconOnly
        value={options.scope}
        onChange={(scope) => setTemplateOptions({ scope })}
        options={SCOPE_OPTIONS}
        testId="template-scope"
      />
      {/* A Dropdown takes its tooltip as a PROP: it lands on the combobox
          trigger (hover AND keyboard focus, aria-describedby on the control
          itself). Never wrap a Dropdown in a <Tooltip> or a <span> for one —
          a Dropdown renders a fragment (trigger + popover), and a wrapper
          span never receives keyboard focus. `ariaLabel` names the combobox;
          the tooltip says what the value means. */}
      <Dropdown<TemplatePrecision>
        ariaLabel="Precision"
        tooltip="Decimal places in the result"
        value={options.precision}
        onChange={(precision) => setTemplateOptions({ precision })}
        options={PRECISION_OPTIONS}
        testId="template-precision"
        optionTestIdPrefix="template-precision-"
      />
      <ControlGridBreak />
      {/* Row 2: on/off options that belong to a set -> Checkbox. The
          tooltip is shown on hover AND given to assistive tech as the
          input's description. */}
      <Checkbox
        label="Live preview"
        checked={options.livePreview}
        onChange={(livePreview) => setTemplateOptions({ livePreview })}
        tooltip="Recalculate the result as the options change"
        testId="template-live-preview"
      />
      <Checkbox
        label="Skip hidden"
        checked={options.skipHidden}
        onChange={(skipHidden) => setTemplateOptions({ skipHidden })}
        tooltip="Leave rows hidden by a filter out of the result"
        testId="template-skip-hidden"
      />
    </ControlGrid>
  );
}
