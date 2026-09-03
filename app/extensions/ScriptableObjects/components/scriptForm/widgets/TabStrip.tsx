//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/widgets/TabStrip.tsx
// PURPOSE: The `tabs` form widget — a tablist over pages of widgets, one page
//          mounted at a time. Left/Right/Home/End move between tabs. A page
//          whose widgets carry errors shows a count on its tab, so a refused
//          submit can never hide its reason on a page the user is not looking
//          at; a focus request for a widget on another page switches to it.

import React, { useState } from "react";
import * as S from "../ScriptFormDialog.styles";

export interface TabStripPage {
  title: string;
  /** Input names on this page (for the error badge and focus routing). */
  inputNames: string[];
  render: () => React.ReactNode;
}

export interface TabStripProps {
  /** Unique per tabs widget: ids for tab/panel pairing. */
  idBase: string;
  widgetName?: string;
  pages: TabStripPage[];
  /** Names currently carrying an error (spec or host). */
  errorNames: ReadonlySet<string>;
  /** A pending focus request; the strip switches to the page that owns it. */
  focusRequest: { name: string; seq: number } | null;
  onInteraction: () => void;
}

export function TabStrip({
  idBase,
  widgetName,
  pages,
  errorNames,
  focusRequest,
  onInteraction,
}: TabStripProps): React.ReactElement | null {
  const [active, setActive] = useState(0);

  // A focus request for a widget on another page brings that page forward;
  // the dialog's focus effect then finds the element on the next render.
  // Derived from the prop during render (the "storing information from
  // previous renders" pattern) rather than in an effect, so the page switch
  // and the focus land in the same commit sequence with no extra pass.
  const [seenFocusSeq, setSeenFocusSeq] = useState(0);
  if (focusRequest !== null && focusRequest.seq !== seenFocusSeq) {
    setSeenFocusSeq(focusRequest.seq);
    const owner = pages.findIndex((p) => p.inputNames.includes(focusRequest.name));
    if (owner >= 0 && owner !== active) setActive(owner);
  }

  if (pages.length === 0) return null;
  const current = Math.min(active, pages.length - 1);

  const select = (index: number): void => {
    const next = ((index % pages.length) + pages.length) % pages.length;
    if (next !== current) {
      setActive(next);
      onInteraction();
    }
    const tab = document.getElementById(`${idBase}-tab-${next}`);
    tab?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        select(current - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        select(current + 1);
        break;
      case "Home":
        e.preventDefault();
        select(0);
        break;
      case "End":
        e.preventDefault();
        select(pages.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div data-form-widget={widgetName} style={{ minWidth: 0 }}>
      <S.TabList role="tablist" onKeyDown={onKeyDown}>
        {pages.map((page, i) => {
          const errors = page.inputNames.filter((n) => errorNames.has(n)).length;
          return (
            <S.Tab
              key={i}
              type="button"
              role="tab"
              id={`${idBase}-tab-${i}`}
              aria-selected={i === current}
              aria-controls={`${idBase}-panel-${i}`}
              tabIndex={i === current ? 0 : -1}
              $active={i === current}
              onClick={() => select(i)}
            >
              <span>{page.title}</span>
              {errors > 0 ? <S.TabBadge aria-label={`${errors} problems`}>{errors}</S.TabBadge> : null}
            </S.Tab>
          );
        })}
      </S.TabList>
      <S.TabPanel
        role="tabpanel"
        id={`${idBase}-panel-${current}`}
        aria-labelledby={`${idBase}-tab-${current}`}
      >
        {pages[current].render()}
      </S.TabPanel>
    </div>
  );
}
