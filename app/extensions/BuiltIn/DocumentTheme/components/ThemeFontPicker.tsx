//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/ThemeFontPicker.tsx
//! PURPOSE: Dropdown to view/switch theme font pairs with live preview on hover.

import React, { useState, useEffect, useRef, useCallback } from "react";
import styled from "styled-components";
import type { ThemeDefinitionData } from "@api";
import {
  getDocumentTheme,
  setDocumentTheme,
} from "@api/theme";
import { onAppEvent, AppEvents } from "@api/events";

const v = (name: string) => `var(${name})`;

/** Predefined font pairs (matching common Excel font combinations). */
const FONT_PAIRS: { heading: string; body: string }[] = [
  { heading: "Calibri Light", body: "Calibri" },
  { heading: "Cambria", body: "Calibri" },
  { heading: "Century Gothic", body: "Century Gothic" },
  { heading: "Trebuchet MS", body: "Trebuchet MS" },
  { heading: "Georgia", body: "Verdana" },
  { heading: "Arial", body: "Arial" },
  { heading: "Segoe UI", body: "Segoe UI" },
  { heading: "Consolas", body: "Consolas" },
];

export function ThemeFontPicker(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeDefinitionData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Snapshot of the theme when the dropdown opens, used to revert preview
  const originalThemeRef = useRef<ThemeDefinitionData | null>(null);
  // Whether the user committed a selection (clicked), so we don't revert
  const committedRef = useRef(false);

  useEffect(() => {
    getDocumentTheme().then(setCurrentTheme);
    const unsub = onAppEvent(AppEvents.THEME_CHANGED, (detail: { theme?: ThemeDefinitionData }) => {
      if (detail?.theme) setCurrentTheme(detail.theme);
    });
    return unsub;
  }, []);

  // Capture original theme when dropdown opens; revert on close if no commit
  useEffect(() => {
    if (isOpen && currentTheme) {
      originalThemeRef.current = currentTheme;
      committedRef.current = false;
    }
    if (!isOpen && originalThemeRef.current && !committedRef.current) {
      // Dropdown closed without a selection - revert preview
      setDocumentTheme(originalThemeRef.current);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setIsOpen(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClickOutside]);

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

  /** Revert to the original theme when the mouse leaves the dropdown. */
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
    currentTheme?.fonts.heading === pair.heading &&
    currentTheme?.fonts.body === pair.body;

  return (
    <Container ref={containerRef}>
      <FontButton onClick={() => setIsOpen(!isOpen)} title="Theme Fonts">
        <FontIcon>Aa</FontIcon>
        <ButtonLabel>Fonts</ButtonLabel>
        <Arrow>{isOpen ? "\u25B2" : "\u25BC"}</Arrow>
      </FontButton>

      {isOpen && (
        <Dropdown onMouseLeave={handleRevertPreview}>
          <DropdownTitle>Theme Fonts</DropdownTitle>
          <FontList>
            {FONT_PAIRS.map((pair) => (
              <FontItem
                key={`${pair.heading}-${pair.body}`}
                $active={isActive(pair)}
                onClick={() => handleApply(pair)}
                onMouseEnter={() => handlePreview(pair)}
              >
                <FontPreview>
                  <HeadingPreview style={{ fontFamily: pair.heading }}>
                    {pair.heading}
                  </HeadingPreview>
                  <BodyPreview style={{ fontFamily: pair.body }}>
                    {pair.body}
                  </BodyPreview>
                </FontPreview>
              </FontItem>
            ))}
          </FontList>
        </Dropdown>
      )}
    </Container>
  );
}

const Container = styled.div`
  position: relative;
`;

const FontButton = styled.button`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  color: ${v("--text-primary")};

  &:hover {
    background: ${v("--ribbon-btn-hover-bg")};
    border-color: ${v("--border-default")};
  }
`;

const FontIcon = styled.span`
  font-size: 16px;
  font-weight: 300;
`;

const ButtonLabel = styled.span`
  font-size: 11px;
`;

const Arrow = styled.span`
  font-size: 7px;
  color: ${v("--text-secondary")};
`;

const Dropdown = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1100;
  margin-top: 2px;
  padding: 8px;
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
`;

const DropdownTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--text-secondary")};
  margin-bottom: 6px;
`;

const FontList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const FontItem = styled.button<{ $active: boolean }>`
  display: flex;
  padding: 6px 8px;
  background: ${(p) => (p.$active ? v("--ribbon-btn-hover-bg") : "transparent")};
  border: 1px solid ${(p) => (p.$active ? v("--accent-primary") : "transparent")};
  border-radius: 4px;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: ${v("--ribbon-btn-hover-bg")};
  }
`;

const FontPreview = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1px;
`;

const HeadingPreview = styled.span`
  font-size: 14px;
  color: ${v("--text-primary")};
`;

const BodyPreview = styled.span`
  font-size: 11px;
  color: ${v("--text-secondary")};
`;
