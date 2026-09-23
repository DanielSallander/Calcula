//! FILENAME: app/src/api/layout/primitives/SegmentedTabs.tsx
// PURPOSE: A tab strip drawn as a Segmented pill — "Fields | Filters | Format"
//          at the top of a pane, "Series | Axis" inside a popover.
// CONTEXT: Panes and popovers switch between a few views often enough that
//          each grew its own tab row, in its own style, most of them plain
//          buttons with a hand-drawn underline and no tab semantics. This is
//          the one strip: the Segmented chrome (so it reads as the same family
//          as every other pill in the ribbon), `role="tablist"` of
//          `role="tab" aria-selected` buttons, and the WAI-ARIA tabs keyboard
//          model — one Tab stop, Left/Right/Home/End move AND activate
//          (automatic activation: the views are cheap to switch).
//
//          The selected look comes from Segmented's `[aria-selected="true"]`
//          rule, the same pressed wash a pressed toggle gets, so selection is
//          driven by the ARIA state and cannot drift from it.
//
//          In the band the strip is as wide as its labels; in a panel or
//          popover it fills the width and the tabs share it equally, which is
//          what a pane header wants.

import React, { useRef } from "react";
import { useSurfaceLayout } from "../context";
import { Button } from "./Button";
import { Segmented } from "./Segmented";
import { moveForKey, stepIndex } from "./roving";

export interface SegmentedTab {
  id: string;
  label: string;
  /** Leading icon, sized by the caller (16 reads best next to 12px text). */
  icon?: React.ReactNode;
}

export interface SegmentedTabsProps {
  tabs: readonly SegmentedTab[];
  /** Id of the selected tab. */
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tablist. */
  ariaLabel: string;
  /** Each tab gets data-testid = testIdPrefix + tab.id. */
  testIdPrefix?: string;
  className?: string;
}

/** Fill the pane width: tabs share it equally. */
const FILL_STYLE: React.CSSProperties = { display: "flex", width: "100%" };

/** A filling tab may shrink below its label: three or four task panes open in
 *  a 320px pane would otherwise push long titles out of their tab. */
const FILL_TAB_STYLE: React.CSSProperties = { minWidth: 0 };

/** The label truncates with an ellipsis instead of overflowing the pill. The
 *  span adds no text, so the tab's textContent is still exactly the label. */
const LABEL_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
  className,
}: SegmentedTabsProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const fill = layout.container !== "band";
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = tabs.findIndex((t) => t.id === value);
  // With no match (a stale value) the first tab keeps the strip reachable.
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const move = moveForKey(e.key, "horizontal");
    if (!move) return;
    const current = tabsRef.current.findIndex((t) => t !== null && t === e.target);
    if (current < 0) return;
    e.preventDefault();
    const next = stepIndex(
      move,
      current,
      tabs.map(() => false),
      true,
    );
    if (next < 0 || next === current) return;
    tabsRef.current[next]?.focus();
    onChange(tabs[next].id);
  };

  return (
    <Segmented
      role="tablist"
      ariaLabel={ariaLabel}
      size="md"
      className={className}
      style={fill ? FILL_STYLE : undefined}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab, i) => {
        const selected = i === selectedIndex;
        return (
          <Button
            key={tab.id}
            ref={(el: HTMLButtonElement | null) => {
              tabsRef.current[i] = el;
            }}
            role="tab"
            aria-selected={selected}
            tabIndex={i === tabStop ? 0 : -1}
            icon={tab.icon}
            grow={fill}
            style={fill ? FILL_TAB_STYLE : undefined}
            title={fill ? tab.label : undefined}
            data-testid={testIdPrefix ? `${testIdPrefix}${tab.id}` : undefined}
            onClick={() => {
              if (!selected) onChange(tab.id);
            }}
          >
            <span style={LABEL_STYLE}>{tab.label}</span>
          </Button>
        );
      })}
    </Segmented>
  );
}
