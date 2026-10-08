//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/ThemeGallery.tsx
//! PURPOSE: The Page Layout "Themes" hero: a CommandButton that opens a card
//!          gallery of the built-in document themes.
//! CONTEXT: Composed from @api/layout primitives only (Calcula Clusters). The
//!          hero used to be a hand-rolled styled-components button whose four
//!          "current theme" swatches were HARDCODED Office colours, so they
//!          never changed when the theme did. The hero is now the icon it
//!          stands for, and the colours live where they are true: each gallery
//!          row previews that theme's six accents, and the ACTIVE row previews
//!          the live document theme from getDocumentTheme (so a document whose
//!          theme was edited — e.g. its fonts swapped — still shows what it
//!          really uses). The dots are colour DATA, not chrome, so they carry
//!          `data-colour-data`.
//!
//!          The rows are ThemeGalleryMenu, shared with the gallery index.ts
//!          registers on the theme-gallery seam (@api/themeGallery), which
//!          other tabs host.

import React, { useCallback, useEffect, useState } from "react";
import type { ThemeDefinitionData } from "@api";
import { listBuiltinThemes, setDocumentTheme, getDocumentTheme } from "@api/theme";
import { onAppEvent, AppEvents } from "@api/events";
import { CommandButton, HERO_ICON_SIZE, Menu, MenuItem, Popover } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { GALLERY_HEADING, GALLERY_WIDTH, THEME_ACCENT_KEYS, themeRowTestId } from "../lib/themeChoices";


/** Six accent dots — categorical colour DATA, so exempt from the token rule. */
function AccentDots({ colors }: { colors: ThemeDefinitionData["colors"] }): React.ReactElement {
  return (
    <span
      data-colour-data=""
      aria-hidden
      style={{ display: "inline-flex", alignItems: "center", gap: 3, flex: "none" }}
    >
      {THEME_ACCENT_KEYS.map((key) => (
        <span
          key={key}
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: colors[key],
            flex: "none",
          }}
        />
      ))}
    </span>
  );
}

/**
 * The gallery itself: the built-in themes as radio rows, the live document
 * theme checked and previewed in its own (possibly edited) colours. ONE body
 * for both doors -- the Page Layout hero's card below, and the gallery other
 * tabs host through @api/themeGallery (index.ts registers it there) -- so the
 * two can never show different galleries.
 * `onClose` is called after a pick has been applied.
 */
export function ThemeGalleryMenu({ onClose }: { onClose: () => void }): React.ReactElement {
  const [themes, setThemes] = useState<ThemeDefinitionData[]>([]);
  // The live document theme: its name decides the checked row, its colours
  // are what that row previews.
  const [liveTheme, setLiveTheme] = useState<ThemeDefinitionData | null>(null);

  useEffect(() => {
    let alive = true;
    getDocumentTheme()
      .then((t) => {
        if (alive) setLiveTheme(t);
      })
      .catch(console.error);
    listBuiltinThemes()
      .then((list) => {
        if (alive) setThemes(list);
      })
      .catch(console.error);
    const unsub = onAppEvent(AppEvents.THEME_CHANGED, (detail: { theme?: ThemeDefinitionData }) => {
      if (detail?.theme) setLiveTheme(detail.theme);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const handleApply = async (theme: ThemeDefinitionData) => {
    await setDocumentTheme(theme);
    onClose();
  };

  const activeName = liveTheme?.name ?? "Office";

  return (
    <Menu ariaLabel="Built-in Themes">
      {themes.map((theme) => {
        const active = theme.name === activeName;
        const colors = active && liveTheme ? liveTheme.colors : theme.colors;
        return (
          <MenuItem
            key={theme.name}
            role="menuitemradio"
            checked={active}
            onSelect={() => void handleApply(theme)}
            title={theme.name}
            testId={themeRowTestId(theme.name)}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <AccentDots colors={colors} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{theme.name}</span>
            </span>
          </MenuItem>
        );
      })}
    </Menu>
  );
}

export function ThemeGallery(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  const close = useCallback(() => setIsOpen(false), []);

  return (
    <>
      <CommandButton
        ref={setAnchor}
        icon={<RibbonIcon.Theme size={HERO_ICON_SIZE} />}
        label="Themes"
        chevron
        tooltip="Document Themes"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-testid="page-layout-themes"
        onClick={() => setIsOpen((open) => !open)}
      />

      <Popover
        anchorEl={anchor}
        open={isOpen}
        onClose={close}
        card
        heading={GALLERY_HEADING}
        width={GALLERY_WIDTH}
      >
        {isOpen && <ThemeGalleryMenu onClose={close} />}
      </Popover>
    </>
  );
}
