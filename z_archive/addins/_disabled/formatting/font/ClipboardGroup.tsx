// FILENAME: app/src/components/Ribbon/tabs/HomeTab/ClipboardGroup.tsx
// PURPOSE: Clipboard group for the Home tab with Cut, Copy, Paste buttons
// CONTEXT: Provides clipboard operations for selected cells

import React, { useState, useCallback, useRef } from "react";
import type { RibbonContext } from "../../../../core/extensions/types";
import { RibbonButton } from "../../../../shell/Ribbon/components";
import { pasteButtonStyles, clipboardButtonStyles } from "../../../../shell/Ribbon/styles/styles";

interface ClipboardGroupProps {
  context: RibbonContext;
}

/**
 * Clipboard icon components
 */
function PasteIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="6" y="4" width="12" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" fill="#fffde7" />
      <rect x="8" y="2" width="8" height="3" rx="1" fill="#ffb300" stroke="currentColor" strokeWidth="1" />
      <rect x="8" y="8" width="8" height="1.5" fill="#90caf9" />
      <rect x="8" y="11" width="6" height="1.5" fill="#90caf9" />
      <rect x="8" y="14" width="7" height="1.5" fill="#90caf9" />
    </svg>
  );
}

function CutIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M5.5 10.5L10.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10.5 10.5L5.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" fill="#e3f2fd" />
      <path d="M3 11V3a1 1 0 011-1h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function FormatPainterIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="6" height="4" rx="1" fill="#ffeb3b" stroke="currentColor" strokeWidth="1" />
      <path d="M8 4h2v2l-1 8h-2l-1-8v-2h2z" fill="#fff9c4" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/**
 * Clipboard formatting controls.
 */
export function ClipboardGroup({
  context,
}: ClipboardGroupProps): React.ReactElement {
  const { selection, isDisabled, onCut, onCopy, onPaste } = context;
  const [isApplying, setIsApplying] = useState(false);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const handleCut = useCallback(async () => {
    if (isDisabled || isApplying || !selectionRef.current) return;
    setIsApplying(true);
    try {
      if (onCut) {
        await onCut();
      }
    } catch (error) {
      console.error("[ClipboardGroup] Cut failed:", error);
    } finally {
      setIsApplying(false);
    }
  }, [isDisabled, isApplying, onCut]);

  const handleCopy = useCallback(async () => {
    if (isDisabled || isApplying || !selectionRef.current) return;
    setIsApplying(true);
    try {
      if (onCopy) {
        await onCopy();
      }
    } catch (error) {
      console.error("[ClipboardGroup] Copy failed:", error);
    } finally {
      setIsApplying(false);
    }
  }, [isDisabled, isApplying, onCopy]);

  const handlePaste = useCallback(async () => {
    if (isDisabled || isApplying || !selectionRef.current) return;
    setIsApplying(true);
    try {
      if (onPaste) {
        await onPaste();
      }
    } catch (error) {
      console.error("[ClipboardGroup] Paste failed:", error);
    } finally {
      setIsApplying(false);
    }
  }, [isDisabled, isApplying, onPaste]);

  const effectiveDisabled = isDisabled || isApplying;
  const noSelection = !selection;

  return (
    <div style={clipboardContainerStyles}>
      {/* Large Paste button */}
      <button
        style={{
          ...pasteButtonStyles,
          opacity: effectiveDisabled || noSelection ? 0.5 : 1,
          cursor: effectiveDisabled || noSelection ? "not-allowed" : "pointer",
        }}
        onClick={handlePaste}
        disabled={effectiveDisabled || noSelection}
        title="Paste (Ctrl+V)"
        type="button"
      >
        <PasteIcon />
        <span style={pasteTextStyles}>Paste</span>
        <span style={dropdownArrowStyles}>v</span>
      </button>

      {/* Small buttons column */}
      <div style={smallButtonsColumnStyles}>
        <RibbonButton
          onClick={handleCut}
          disabled={effectiveDisabled || noSelection}
          title="Cut (Ctrl+X)"
          style={clipboardButtonStyles}
        >
          <CutIcon />
        </RibbonButton>
        <RibbonButton
          onClick={handleCopy}
          disabled={effectiveDisabled || noSelection}
          title="Copy (Ctrl+C)"
          style={clipboardButtonStyles}
        >
          <CopyIcon />
        </RibbonButton>
        <RibbonButton
          onClick={() => {}}
          disabled={true}
          title="Format Painter"
          style={clipboardButtonStyles}
        >
          <FormatPainterIcon />
        </RibbonButton>
      </div>
    </div>
  );
}

// Styles
const clipboardContainerStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "stretch",
  gap: "4px",
  height: "66px",
};

const smallButtonsColumnStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  justifyContent: "flex-start",
};

const pasteTextStyles: React.CSSProperties = {
  fontSize: "11px",
  marginTop: "2px",
};

const dropdownArrowStyles: React.CSSProperties = {
  fontSize: "8px",
  marginLeft: "2px",
  opacity: 0.6,
};