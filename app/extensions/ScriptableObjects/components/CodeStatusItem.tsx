//! FILENAME: app/extensions/ScriptableObjects/components/CodeStatusItem.tsx
// PURPOSE: The status bar's code-and-scripts indicator: one shield beside the
//          selection readout that says, without being opened, whether this file
//          holds code, how much, and whether anything is worth a look -- and
//          opens onto a short account of it with the two panels behind it.
// CONTEXT: Replaces the two always-identical activity-bar icons ("Code in This
//          File" and "Script Permissions"); both panels are still registered
//          (hidden from the rail) and open from here, from Developer, and from
//          View > Sidebar. Every word it shows comes from deriveCodeStatus
//          (../lib/codeStatus.ts); this file only draws it.
//
//          THE STATES, at a glance:
//          - empty shield, quiet .......... checking (the file is being read)
//          - checked shield, quiet ........ no code, nothing held, nothing refused
//          - checked shield + number ...... code in the file, nothing worth a look
//          - "!" shield + number + dot .... something worth a look
//          - empty shield + "?" + dot ..... the code could not be fully read
//                                           (never shown as "no code")
//
//          HOST CHROME A SCRIPT CANNOT IMITATE OR HIDE. The text beside it (the
//          mode slot) is writable by scripts through Application.StatusBar; this
//          is a host-drawn button in a darker well, which plain text cannot
//          reproduce, and the status bar truncates that text rather than let it
//          push this item away (StatusBar.tsx LEFT_ZONE_STYLE). Scripts cannot
//          register status-bar items at all.
//
//          The popover is the design system's MenuButton (keyboard model
//          included: Enter/Space/ArrowDown open it, arrows move, Escape returns
//          focus here). Its facts are presentation rows above the two items,
//          which the menu's arrow keys never reach, so they are the menu's
//          DESCRIPTION (aria-describedby): a screen reader reads every fact,
//          details included, as the menu opens. The trigger's own name carries
//          the headline and everything worth a look. Right-click anywhere on the
//          item or in its popover opens/keeps the popover, never the status
//          bar's Sum/Average menu.

import React, { useId, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
import { FONT_FAMILY, LT, MenuButton, MenuItem, MenuSeparator } from "@api/layout";
import { IconScript } from "@api";
import {
  deriveCodeStatus,
  type CodeStatusFact,
  type CodeStatusLevel,
  type CodeStatusSource,
} from "../lib/codeStatus";
import { shieldGlyph, type ShieldMark } from "./shieldGlyph";

// ============================================================================
// Colours: the status-bar tokens (core/theme/tokens.ts), light values as
// fallbacks. Contrast of every pair is pinned in tokens.test.ts.
// ============================================================================

const BAR_FG = "var(--status-bar-fg, #ffffff)";
const QUIET_FG =
  "var(--status-bar-fg-quiet, color-mix(in srgb, var(--status-bar-fg, #ffffff) 72%, transparent))";
const WELL = "var(--status-bar-item-bg, color-mix(in oklab, var(--status-bar-bg, #217346) 85%, black))";
const WELL_HOVER =
  "var(--status-bar-item-hover-bg, color-mix(in oklab, var(--status-bar-bg, #217346) 72%, black))";
const ATTENTION = "var(--status-bar-attention, #ffc83d)";

/** The popover's width: room for a fact and its detail on two short lines. */
const POPOVER_WIDTH = 300;

/** The largest count drawn as a number; above it the chip says "99+". */
const MAX_DRAWN_COUNT = 99;

/** What the shield says inside it, per state (see shieldGlyph.ts). */
const MARK_FOR_LEVEL: Record<CodeStatusLevel, ShieldMark> = {
  loading: "none",
  none: "check",
  present: "check",
  notice: "alert",
  unknown: "none",
};

// ============================================================================
// Styles
// ============================================================================

const dotClass = css`
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${ATTENTION};
  /* A ring of the well's own colour, so the dot reads as a separate mark
     instead of merging with the shield's stroke. */
  box-shadow: 0 0 0 1.5px ${WELL};
`;

const triggerClass = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* Never shrinks: the status bar's left zone gives way in its TEXT slots
     only (StatusBar.tsx), and this item keeps its width. */
  flex: none;
  box-sizing: border-box;
  height: 18px;
  margin: 0;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: ${WELL};
  color: ${BAR_FG};
  font-family: ${FONT_FAMILY};
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background ${LT.motionHover};

  &:hover,
  &[aria-expanded="true"] {
    background: ${WELL_HOVER};
  }
  /* The dot is reached by ATTRIBUTE, never as .\${dotClass}: @emotion/css
     treats a class name it made, interpolated into another css call, as
     COMPOSITION and pastes that class's styles in its place -- which put the
     dot's 7px size and amber fill on this button (found live, 2026-10-03). */
  &:hover [data-attention-dot],
  &[aria-expanded="true"] [data-attention-dot] {
    box-shadow: 0 0 0 1.5px ${WELL_HOVER};
  }
  &:focus-visible {
    outline: 2px solid ${BAR_FG};
    outline-offset: 1px;
  }
  /* Nothing to report (or nothing known yet): the shield recedes. */
  &[data-level="none"],
  &[data-level="loading"] {
    color: ${QUIET_FG};
  }
`;

const iconSlotClass = css`
  position: relative;
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;

  & svg {
    width: 14px;
    height: 14px;
  }
`;

const factsClass = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 4px 4px;
  font-family: ${FONT_FAMILY};
  color: ${LT.text};
  cursor: default;
  user-select: text;
`;

const headingClass = css`
  padding: 4px 4px 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
`;

const factClass = css`
  display: grid;
  grid-template-columns: 14px 1fr;
  align-items: start;
  padding: 3px 4px;
  font-size: 12px;
  line-height: 1.35;
`;

/** Worth a look is said in weight as well as in colour (never colour alone). */
const factNoticeClass = css`
  font-weight: 600;
`;

const factMarkClass = css`
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
  background: ${LT.textTertiary};
`;

const factMarkNoticeClass = css`
  background: ${LT.warnFg};
`;

const factDetailClass = css`
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: ${LT.textSecondary};
  overflow-wrap: anywhere;
`;

/** Read by a screen reader, not drawn. */
const visuallyHiddenClass = css`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`;

/** Takes every right-click inside the item -- the trigger AND its portalled
 *  popover, whose events bubble through the React tree to the status bar's
 *  own handler (the Sum/Average menu). */
const swallowContextMenu = (e: React.MouseEvent): void => {
  e.preventDefault();
  e.stopPropagation();
};

// ============================================================================
// Component
// ============================================================================

/** Which of the two panels behind the indicator to open. */
export type CodeStatusDoor = "code" | "permissions";

/** Opens one of the two panels behind the indicator. */
export type OpenCodePanel = (door: CodeStatusDoor) => void;

function Fact({ fact }: { fact: CodeStatusFact }): React.ReactElement {
  return (
    <div
      className={[factClass, fact.notice ? factNoticeClass : ""].join(" ")}
      data-code-status-fact={fact.id}
      data-notice={fact.notice ? "true" : "false"}
    >
      <span className={[factMarkClass, fact.notice ? factMarkNoticeClass : ""].join(" ")} aria-hidden />
      <span>
        {fact.notice && <span className={visuallyHiddenClass}>Worth a look: </span>}
        {fact.text}
        {fact.detail && <span className={factDetailClass}>{fact.detail}</span>}
      </span>
    </div>
  );
}

/**
 * The indicator, bound to the source that feeds it and to the function that
 * opens a panel. A factory, so the extension registers one component for its
 * own source and a test can hand it a source of its own.
 */
export function createCodeStatusItem(
  source: CodeStatusSource,
  openPanel: OpenCodePanel,
): React.ComponentType {
  function CodeStatusItem(): React.ReactElement {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
    const view = deriveCodeStatus(snapshot);
    const factsId = useId();
    const attention = view.level === "notice" || view.level === "unknown";
    const refused = snapshot.refusals;
    // Whatever the poll last saw, a popover the user is opening reads fresh:
    // this is the moment a stale number would be believed. Every way in asks --
    // a click, Enter/Space (a click), right-click (a click), and the arrows.
    const readFresh = (): void => void source.refreshNow();

    const trigger = (
      <button
        type="button"
        className={triggerClass}
        data-testid="code-status"
        data-level={view.level}
        data-count={view.count ?? ""}
        aria-label={view.ariaLabel}
        title={view.title}
        onClick={readFresh}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") readFresh();
        }}
        onContextMenu={(e) => {
          // The user means THIS item: open it (unless it already is).
          if (e.currentTarget.getAttribute("aria-expanded") !== "true") e.currentTarget.click();
        }}
      >
        <span className={iconSlotClass}>
          {shieldGlyph(14, 1.8, MARK_FOR_LEVEL[view.level])}
          {attention && (
            <span className={dotClass} data-testid="code-status-dot" data-attention-dot="" aria-hidden />
          )}
        </span>
        {view.level === "unknown" ? (
          <span aria-hidden>?</span>
        ) : view.count !== null && view.count > 0 ? (
          <span aria-hidden>{view.count > MAX_DRAWN_COUNT ? `${MAX_DRAWN_COUNT}+` : view.count}</span>
        ) : null}
      </button>
    );

    return (
      <span style={{ display: "contents" }} onContextMenu={swallowContextMenu}>
        <MenuButton
          trigger={trigger}
          placement="top-start"
          width={POPOVER_WIDTH}
          ariaLabel="Code and scripts"
          ariaDescribedBy={factsId}
        >
          <div id={factsId} className={factsClass} role="presentation" data-testid="code-status-facts">
            <div className={headingClass}>Code and scripts</div>
            {view.facts.length === 0 ? (
              <div className={factClass} data-code-status-fact="loading">
                <span className={factMarkClass} aria-hidden />
                <span>Checking the code in this file&hellip;</span>
              </div>
            ) : (
              view.facts.map((fact) => <Fact key={fact.id} fact={fact} />)
            )}
          </div>
          <MenuSeparator />
          <MenuItem
            testId="code-status-open-code"
            icon={IconScript}
            hint={view.count !== null && view.count > 0 ? String(view.count) : undefined}
            onSelect={() => openPanel("code")}
          >
            Code in This File
          </MenuItem>
          <MenuItem
            testId="code-status-open-permissions"
            // The menu's icon slot is 20px (listRow.ts) and IconScript fills
            // it; a 16px shield sat visibly smaller beside it.
            icon={shieldGlyph(20)}
            hint={refused > 0 ? `${refused} refused` : undefined}
            onSelect={() => openPanel("permissions")}
          >
            Script Permissions
          </MenuItem>
        </MenuButton>
      </span>
    );
  }
  return CodeStatusItem;
}
