//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/ThemeFontPicker.tsx
//! PURPOSE: The Page Layout "Fonts" hero: a CommandButton that opens a card
//!          list of theme font pairs, each previewed in its own faces, with a
//!          live preview on hover.
//! CONTEXT: Composed from @api/layout primitives only (Calcula Clusters); the
//!          hand-rolled styled-components hero and dropdown are gone. The
//!          preview contract is unchanged from the old picker:
//!            - opening snapshots the document theme;
//!            - hovering a row applies that pair to the grid temporarily;
//!            - leaving the list, or closing without a pick, restores the
//!              snapshot;
//!            - clicking a row commits it (and the snapshot follows the commit).

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ThemeDefinitionData } from "@api";
import { getDocumentTheme, setDocumentTheme } from "@api/theme";
import { onAppEvent, AppEvents } from "@api/events";
import { CommandButton, HERO_ICON_SIZE, Menu, MenuItem, Popover } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { FONT_PAIRS, fontPairTestId } from "../lib/themeChoices";

/** Card width: the heading face at 14px plus the body face as a trailing hint. */
const PICKER_WIDTH = 280;

export function ThemeFontPicker(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeDefinitionData | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  // Snapshot of the theme when the dropdown opens, used to revert preview
  const originalThemeRef = useRef<ThemeDefinitionData | null>(null);
  // Whether the user committed a selection (clicked), so we don't revert
  const committedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    getDocumentTheme()
      .then((t) => {
        if (alive) setCurrentTheme(t);
      })
      .catch(console.error);
    const unsub = onAppEvent(AppEvents.THEME_CHANGED, (detail: { theme?: ThemeDefinitionData }) => {
      if (detail?.theme) setCurrentTheme(detail.theme);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // Capture original theme when dropdown opens; revert on close if no commit
  useEffect(() => {
    if (isOpen && currentTheme) {
      originalThemeRef.current = currentTheme;
      committedRef.current = false;
    }
    if (!isOpen && originalThemeRef.current && !committedRef.current) {
      // Dropdown closed without a selection - revert preview
      void setDocumentTheme(originalThemeRef.current);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => setIsOpen(false), []);

  /** Live-preview: temporarily apply hovered font pair to the grid. */
  const handlePreview = async (pair: { heading: string; body: string }) => {
    const base = originalThemeRef.current;
    if (!base) return;
    const preview: ThemeDefinitionData = {
      ...base,
      fonts: { heading: pair.heading, body: pair.body },
    };
    await setDocumentTheme(preview);
  };

  /** Revert to the original theme when the mouse leaves the list. */
  const handleRevertPreview = async () => {
    if (originalThemeRef.current && !committedRef.current) {
      await setDocumentTheme(originalThemeRef.current);
    }
  };

  /** Permanently apply the selected font pair. */
  const handleApply = async (pair: { heading: string; body: string }) => {
    const base = originalThemeRef.current ?? currentTheme;
    if (!base) return;
    committedRef.current = true;
    const updated: ThemeDefinitionData = {
      ...base,
      fonts: { heading: pair.heading, body: pair.body },
    };
    await setDocumentTheme(updated);
    // Update the snapshot so future previews use the new committed theme
    originalThemeRef.current = updated;
    setIsOpen(false);
  };

  const isActive = (pair: { heading: string; body: string }) =>
    currentTheme?.fonts?.heading === pair.heading &&
    currentTheme?.fonts?.body === pair.body;

  return (
    <>
      <CommandButton
        ref={setAnchor}
        icon={<RibbonIcon.Fonts size={HERO_ICON_SIZE} />}
        label="Fonts"
        chevron
        tooltip="Theme Fonts"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-testid="page-layout-fonts"
        onClick={() => setIsOpen((open) => !open)}
      />

      <Popover
        anchorEl={anchor}
        open={isOpen}
        onClose={close}
        card
        heading="Theme Fonts"
        width={PICKER_WIDTH}
      >
        <Menu ariaLabel="Theme Fonts" onMouseLeave={() => void handleRevertPreview()}>
          {FONT_PAIRS.map((pair) => (
            <MenuItem
              key={`${pair.heading}-${pair.body}`}
              role="menuitemradio"
              checked={isActive(pair)}
              onSelect={() => void handleApply(pair)}
              onMouseEnter={() => void handlePreview(pair)}
              title={`Headings: ${pair.heading} / Body: ${pair.body}`}
              testId={fontPairTestId(pair)}
              hint={<span style={{ fontFamily: pair.body }}>{pair.body}</span>}
            >
              <span style={{ fontFamily: pair.heading, fontSize: 14 }}>{pair.heading}</span>
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </>
  );
}
