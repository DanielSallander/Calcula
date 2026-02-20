//! FILENAME: app/extensions/DataValidation/components/ErrorAlertModal.tsx
// PURPOSE: Error alert modal shown when invalid data is entered.
// CONTEXT: Displayed by the commit guard handler. Shows Stop, Warning, or Information alerts.

import React from "react";
import type { DialogProps } from "../../../src/api";
import type { ErrorAlertData } from "../types";
import { resolveErrorAlert } from "../handlers/commitGuardHandler";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10000,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  minWidth: 340,
  maxWidth: 480,
  padding: 0,
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const titleBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "16px",
};

const iconStyle: React.CSSProperties = {
  fontSize: 32,
  lineHeight: 1,
  flexShrink: 0,
};

const messageStyle: React.CSSProperties = {
  flex: 1,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const buttonBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "8px 16px 16px",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #ababab",
  borderRadius: 2,
  backgroundColor: "#e1e1e1",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0078d4",
};

// ============================================================================
// Icon Components
// ============================================================================

function StopIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" style={iconStyle}>
      <circle cx="16" cy="16" r="14" fill="#d32f2f" />
      <line x1="10" y1="10" x2="22" y2="22" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="22" y1="10" x2="10" y2="22" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" style={iconStyle}>
      <polygon points="16,2 30,28 2,28" fill="#ffc107" stroke="#b8860b" strokeWidth="1" />
      <text x="16" y="24" textAnchor="middle" fontSize="18" fontWeight="bold" fill="#000">!</text>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" style={iconStyle}>
      <circle cx="16" cy="16" r="14" fill="#1976d2" />
      <text x="16" y="13" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#fff">i</text>
      <rect x="14" y="16" width="4" height="10" rx="1" fill="#fff" />
    </svg>
  );
}

// ============================================================================
// Component
// ============================================================================

export function ErrorAlertModal(props: DialogProps) {
  const { isOpen, onClose } = props;
  const data = props.data as unknown as ErrorAlertData | undefined;

  if (!isOpen || !data) {
    return null;
  }

  const { title, message, style } = data;

  const handleRetry = () => {
    resolveErrorAlert({ action: "retry" });
    onClose();
  };

  const handleCancel = () => {
    resolveErrorAlert({ action: "block" });
    onClose();
  };

  const handleAllow = () => {
    resolveErrorAlert({ action: "allow" });
    onClose();
  };

  // Handle keyboard
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleCancel();
    } else if (e.key === "Enter") {
      if (style === "stop") {
        handleRetry();
      } else {
        handleAllow();
      }
    }
  };

  const renderIcon = () => {
    switch (style) {
      case "stop":
        return <StopIcon />;
      case "warning":
        return <WarningIcon />;
      case "information":
        return <InfoIcon />;
      default:
        return <StopIcon />;
    }
  };

  const renderButtons = () => {
    switch (style) {
      case "stop":
        return (
          <>
            <button style={primaryButtonStyle} onClick={handleRetry} autoFocus>Retry</button>
            <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          </>
        );
      case "warning":
        return (
          <>
            <button style={primaryButtonStyle} onClick={handleAllow} autoFocus>Yes</button>
            <button style={buttonStyle} onClick={handleRetry}>No</button>
            <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          </>
        );
      case "information":
        return (
          <>
            <button style={primaryButtonStyle} onClick={handleAllow} autoFocus>OK</button>
            <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          </>
        );
      default:
        return (
          <>
            <button style={primaryButtonStyle} onClick={handleRetry} autoFocus>Retry</button>
            <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          </>
        );
    }
  };

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown}>
      <div style={dialogStyle} role="alertdialog" aria-labelledby="dv-error-title" aria-describedby="dv-error-message">
        <div style={titleBarStyle} id="dv-error-title">
          {title}
        </div>
        <div style={bodyStyle}>
          {renderIcon()}
          <div style={messageStyle} id="dv-error-message">
            {message}
          </div>
        </div>
        <div style={buttonBarStyle}>
          {renderButtons()}
        </div>
      </div>
    </div>
  );
}
