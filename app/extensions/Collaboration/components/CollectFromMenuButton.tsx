//! FILENAME: app/extensions/Collaboration/components/CollectFromMenuButton.tsx
// PURPOSE: Writeback > Collect From: the control that chooses which STREAMS
//          (the development line, each environment) this workbook's Collected
//          Responses, exports, scripts and model tables collect from.
// CONTEXT: ONE component in two places, over ONE store
//          (lib/collectStreamsStore.ts) over ONE choice in Rust:
//          - presentation "hero" (the default): the publisher Writeback tab's
//            hero in the band (a CommandButton);
//          - presentation "dropdown": the Collected Responses pane, where it is
//            the @api/layout FIELD TRIGGER (the Dropdown's own field: full
//            width, field height, a chevron) that SAYS the current choice
//            ("prod", "test, prod", "All streams"), under a "Collect from"
//            label. The pane used to show the hero there, which outside the
//            band is a 28px icon + "Collect From" button; squeezed into one row
//            beside the region select its funnel overlapped the select and its
//            label was cut to "Collect Fr" (owner, 2026-10-22).
//          Both presentations open the SAME menu. The pane's former stream
//          picker is gone (owner decision 2026-10-22).
//
//          A stay-open menu of check rows (MenuButton closeOnSelect={false}, the
//          documented use: "a menu of checkboxes the user toggles several of in
//          a row"), built only from @api/layout and LT tokens (no colour
//          literals: the chromeColorConfigs hex ban in app/eslint.boundaries.js
//          covers this file). The last ticked row is disabled, because an empty
//          choice is refused. Streams are named in ONE order everywhere -- the
//          menu's (collectStreamsModel.ts `collectedInMenuOrder`) -- in the
//          dropdown, its tooltip and the pane's strip.

import React, { useSyncExternalStore } from "react";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  Badge,
  CommandButton,
  FieldTrigger,
  FieldTriggerText,
  HERO_ICON_SIZE,
  MenuButton,
  MenuHeading,
  MenuItem,
  MenuSeparator,
} from "@api/layout";
import type { CollectionStreamsView } from "@api/collaboration";
import {
  subscribeCollectStreams,
  getCollectStreamsVersion,
  getCollectStreamsView,
  getCollectStreamsError,
  refreshCollectStreams,
  applyCollectChoice,
  toggleCollectStream,
} from "../lib/collectStreamsStore";
import {
  COLLECT_FROM_HEADING,
  choiceTestId,
  collectedInMenuOrder,
  defaultRowLabel,
  heroBadge,
  heroTooltip,
  isLastIncluded,
  readErrorText,
} from "../lib/collectStreamsModel";

/** How the trigger looks; the menu behind it is the same. */
export type CollectFromPresentation = "hero" | "dropdown";

export interface CollectFromMenuButtonProps {
  /** `writeback-tab-collect-from` in the band, `publisher-dashboard-collect-from` in the pane. */
  testId: string;
  /** "hero" (default): the Writeback tab's hero. "dropdown": the Collected
   *  Responses pane's field trigger that names the current choice. */
  presentation?: CollectFromPresentation;
  /** The trigger's id, so a label can name it (`<Field htmlFor>`): a click on
   *  the label then focuses the control. The MenuButton keeps a trigger's own
   *  id. */
  id?: string;
}

// ============================================================================
// What the dropdown says
// ============================================================================

/** The trigger's text before the first read has answered. */
export const COLLECT_FROM_LOADING_TEXT = "Loading…";
/** The trigger's text for a workbook that has published nothing (no link). */
export const COLLECT_FROM_NOT_PUBLISHED_TEXT = "Not published yet";
/** The trigger's text when the view could not be read at all. */
export const COLLECT_FROM_READ_FAILED_TEXT = "Could not read";

/**
 * The CURRENT CHOICE as the pane's dropdown says it, in the menu's own words
 * and order (the development line, then the pipeline): "prod", "test, prod",
 * "All streams". It is what is collected NOW -- the default resolved to the
 * last environment, "All streams" for every stream -- so the text and the
 * ticked rows of the menu never disagree. A choice Rust could not resolve (the
 * pipeline unreadable, an unauthorised pointer) is said in Rust's own words
 * (`summary`), never as a stream it is not collecting.
 */
export function collectFromChoiceText(
  view: CollectionStreamsView | null,
  error?: string | null,
): string {
  if (!view || !view.linked) {
    if (error) return COLLECT_FROM_READ_FAILED_TEXT;
    return view ? COLLECT_FROM_NOT_PUBLISHED_TEXT : COLLECT_FROM_LOADING_TEXT;
  }
  if (view.mode === "all") return "All streams";
  const words = collectedInMenuOrder(view);
  if (words === null) {
    // Every stream (the default while the pipeline has no environments), or a
    // choice that could not be resolved.
    return view.environmentsError ? view.summary || COLLECT_FROM_READ_FAILED_TEXT : "All streams";
  }
  return words.length > 0 ? words.join(", ") : view.summary;
}

// ============================================================================
// The control
// ============================================================================

export function CollectFromMenuButton({
  testId,
  presentation = "hero",
  id,
}: CollectFromMenuButtonProps): React.ReactElement {
  useSyncExternalStore(subscribeCollectStreams, getCollectStreamsVersion, getCollectStreamsVersion);
  const view = getCollectStreamsView();
  const error = getCollectStreamsError();
  const linked = view?.linked === true;
  const locked = !view?.canChange;
  // A failed read keeps the trigger live: clicking it is the retry.
  const disabled = !linked && !error;
  const badge = heroBadge(view, error);
  const tooltip = heroTooltip(view, error);
  // Chained BEFORE the menu opens: a just-defined environment, or a choice
  // changed in the other view, shows when the menu does.
  const refresh = () => void refreshCollectStreams();
  const text = collectFromChoiceText(view, error);

  const trigger =
    presentation === "dropdown" ? (
      // Named "Collect from: <choice>" for assistive tech, because the visible
      // text alone ("prod") does not say what it chooses. The count pill is the
      // hero's; the field already names the streams, so only the "!" shows.
      <FieldTrigger
        id={id}
        aria-label={`Collect from: ${text}`}
        data-presentation="dropdown"
        disabled={disabled}
        title={tooltip}
        data-testid={testId}
        onClick={refresh}
        trailing={badge === "!" ? <Badge aria-hidden>!</Badge> : undefined}
      >
        <FieldTriggerText data-collect-from-text="">{text}</FieldTriggerText>
      </FieldTrigger>
    ) : (
      <CommandButton
        id={id}
        icon={<RibbonIcon.Filter size={HERO_ICON_SIZE} />}
        label="Collect From"
        labelLines={2}
        chevron
        badge={badge}
        disabled={disabled}
        title={tooltip}
        data-testid={testId}
        onClick={refresh}
      />
    );

  return (
    <MenuButton closeOnSelect={false} ariaLabel={COLLECT_FROM_HEADING} trigger={trigger}>
      <MenuHeading>{COLLECT_FROM_HEADING}</MenuHeading>
      {error && <MenuHeading>{readErrorText(error)}</MenuHeading>}
      {view && linked && (
        <>
          <MenuItem
            role="menuitemcheckbox"
            checked={view.mode === "all"}
            hint="includes new environments"
            disabled={locked}
            testId="writeback-collect-all"
            onSelect={() => void applyCollectChoice("all")}
          >
            All streams
          </MenuItem>
          {defaultRowLabel(view) && (
            <MenuItem
              disabled={locked}
              testId="writeback-collect-default"
              onSelect={() => void applyCollectChoice(null)}
            >
              {defaultRowLabel(view)}
            </MenuItem>
          )}
          <MenuSeparator />
          {view.choices.map((choice) => (
            <MenuItem
              key={`${choice.kind}:${choice.stream}`}
              role="menuitemcheckbox"
              checked={choice.included}
              hint={choice.hint || undefined}
              disabled={locked || isLastIncluded(view, choice)}
              testId={choiceTestId(choice.stream)}
              // A TOGGLE, computed in the store's write chain from the view
              // as it stands then -- two quick ticks never lose the first.
              onSelect={() => void toggleCollectStream(choice.stream)}
            >
              {choice.label}
            </MenuItem>
          ))}
          {view.environmentsError && <MenuHeading>{view.environmentsError}</MenuHeading>}
          {locked && view.changeRefusal && <MenuHeading>{view.changeRefusal}</MenuHeading>}
        </>
      )}
    </MenuButton>
  );
}
