//! FILENAME: app/extensions/Collaboration/components/CollectFromMenuButton.tsx
// PURPOSE: Writeback > Collect From: the control that chooses which STREAMS
//          (the development line, each environment) this workbook's Collected
//          Responses, exports, scripts and model tables collect from.
// CONTEXT: ONE component in two places -- the publisher Writeback tab (a hero in
//          the band) and the Collected Responses pane (a 28px button there,
//          through CommandButton's own surface adaptation) -- over ONE store
//          (lib/collectStreamsStore.ts) over ONE choice in Rust. The pane's
//          former stream picker is gone (owner decision 2026-10-22).
//
//          A stay-open menu of check rows (MenuButton closeOnSelect={false}, the
//          documented use: "a menu of checkboxes the user toggles several of in
//          a row"), built only from @api/layout (no colour literals: the hex ban
//          in app/eslint.boundaries.js covers this file). The last ticked row is
//          disabled, because an empty choice is refused.

import React, { useSyncExternalStore } from "react";
import { RibbonIcon } from "@api/ribbonIcons";
import { CommandButton, MenuButton, MenuItem, MenuSeparator, MenuHeading, HERO_ICON_SIZE } from "@api/layout";
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
  defaultRowLabel,
  heroBadge,
  heroTooltip,
  isLastIncluded,
  readErrorText,
} from "../lib/collectStreamsModel";

export interface CollectFromMenuButtonProps {
  /** `writeback-tab-collect-from` in the band, `publisher-dashboard-collect-from` in the pane. */
  testId: string;
}

export function CollectFromMenuButton({ testId }: CollectFromMenuButtonProps): React.ReactElement {
  useSyncExternalStore(subscribeCollectStreams, getCollectStreamsVersion, getCollectStreamsVersion);
  const view = getCollectStreamsView();
  const error = getCollectStreamsError();
  const linked = view?.linked === true;
  const locked = !view?.canChange;

  return (
    <MenuButton
      closeOnSelect={false}
      ariaLabel={COLLECT_FROM_HEADING}
      trigger={
        <CommandButton
          icon={<RibbonIcon.Filter size={HERO_ICON_SIZE} />}
          label="Collect From"
          labelLines={2}
          chevron
          badge={heroBadge(view, error)}
          // A failed read keeps the trigger live: clicking it is the retry.
          disabled={!linked && !error}
          title={heroTooltip(view, error)}
          data-testid={testId}
          // Chained BEFORE the menu opens: a just-defined environment, or a
          // choice changed in the other view, shows when the menu does.
          onClick={() => void refreshCollectStreams()}
        />
      }
    >
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
