//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/ThemeGallery.tsx
//! PURPOSE: Dropdown gallery showing built-in themes with color swatches.

import React, { useState, useEffect, useRef, useCallback } from "react";
import styled from "styled-components";
import type { ThemeDefinitionData } from "@api";
import {
  listBuiltinThemes,
  setDocumentTheme,
  getDocumentTheme,
} from "@api/theme";
import { onAppEvent, AppEvents } from "@api/events";

const v = (name: string) => `var(${name})`;

export function ThemeGallery(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [themes, setThemes] = useState<ThemeDefinitionData[]>([]);
  const [activeThemeName, setActiveThemeName] = useState("Office");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getDocumentTheme().then((t) => setActiveThemeName(t.name));
    const unsub = onAppEvent(AppEvents.THEME_CHANGED, (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.theme) setActiveThemeName(detail.theme.name);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (isOpen && themes.length === 0) {
      listBuiltinThemes().then(setThemes).catch(console.error);
    }
  }, [isOpen, themes.length]);

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

  const handleApply = async (theme: ThemeDefinitionData) => {
    await setDocumentTheme(theme);
    setIsOpen(false);
  };

  return (
    <Container ref={containerRef}>
      <ThemeButton onClick={() => setIsOpen(!isOpen)} title="Document Themes">
        <SwatchRow>
          <MiniSwatch style={{ background: "var(--accent-primary, #4472c4)" }} />
          <MiniSwatch style={{ background: "#ed7d31" }} />
          <MiniSwatch style={{ background: "#a5a5a5" }} />
          <MiniSwatch style={{ background: "#ffc000" }} />
        </SwatchRow>
        <ButtonLabel>Themes</ButtonLabel>
        <Arrow>{isOpen ? "\u25B2" : "\u25BC"}</Arrow>
      </ThemeButton>

      {isOpen && (
        <Dropdown>
          <DropdownTitle>Built-in Themes</DropdownTitle>
          <ThemeList>
            {themes.map((theme) => (
              <ThemeItem
                key={theme.name}
                $active={theme.name === activeThemeName}
                onClick={() => handleApply(theme)}
                title={theme.name}
              >
                <ThemeSwatches>
                  <ThemeSwatch style={{ backgroundColor: theme.colors.dark1 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.light1 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.dark2 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.light2 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.accent1 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.accent2 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.accent3 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.accent4 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.accent5 }} />
                  <ThemeSwatch style={{ backgroundColor: theme.colors.accent6 }} />
                </ThemeSwatches>
                <ThemeName>{theme.name}</ThemeName>
              </ThemeItem>
            ))}
          </ThemeList>
        </Dropdown>
      )}
    </Container>
  );
}

// Styled components
const Container = styled.div`
  position: relative;
`;

const ThemeButton = styled.button`
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

const SwatchRow = styled.div`
  display: flex;
  gap: 1px;
`;

const MiniSwatch = styled.div`
  width: 8px;
  height: 8px;
  border-radius: 1px;
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
  min-width: 280px;
`;

const DropdownTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--text-secondary")};
  margin-bottom: 6px;
`;

const ThemeList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const ThemeItem = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  background: ${(p) => (p.$active ? v("--ribbon-btn-hover-bg") : "transparent")};
  border: 1px solid ${(p) => (p.$active ? v("--accent-primary") : "transparent")};
  border-radius: 4px;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: ${v("--ribbon-btn-hover-bg")};
  }
`;

const ThemeSwatches = styled.div`
  display: flex;
  gap: 1px;
`;

const ThemeSwatch = styled.div`
  width: 14px;
  height: 14px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.1);
`;

const ThemeName = styled.span`
  font-size: 12px;
  color: ${v("--text-primary")};
`;
