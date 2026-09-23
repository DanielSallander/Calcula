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

import React, { useCallback, useEffect, useState } from "react";
import type { ThemeDefinitionData } from "@api";
import { listBuiltinThemes, setDocumentTheme, getDocumentTheme } from "@api/theme";
import { onAppEvent, AppEvents } from "@api/events";
import { CommandButton, HERO_ICON_SIZE, Menu, MenuItem, Popover } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { THEME_ACCENT_KEYS, themeRowTestId } from "../lib/themeChoices";

/** Card width: six dots, a theme name and the check column side by side. */
const GALLERY_WIDTH = 260;

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

export function ThemeGallery(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [themes, setThemes] = useState<ThemeDefinitionData[]>([]);
  // The live document theme: its name decides the checked row, its colours
  // are what that row previews.
  const [liveTheme, setLiveTheme] = useState<ThemeDefinitionData | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  useEffect(() => {
    let alive = true;
    getDocumentTheme()
      .then((t) => {
        if (alive) setLiveTheme(t);
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

  useEffect(() => {
    if (isOpen && themes.length === 0) {
      listBuiltinThemes().then(setThemes).catch(console.error);
    }
  }, [isOpen, themes.length]);

  const close = useCallback(() => setIsOpen(false), []);

  const handleApply = async (theme: ThemeDefinitionData) => {
    await setDocumentTheme(theme);
    setIsOpen(false);
  };

  const activeName = liveTheme?.name ?? "Office";

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
        heading="Built-in Themes"
        width={GALLERY_WIDTH}
      >
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
      </Popover>
    </>
  );
}
