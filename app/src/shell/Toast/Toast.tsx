//! FILENAME: app/src/shell/Toast/Toast.tsx
// PURPOSE: Toast notification UI component.
// CONTEXT: Renders toast messages at the bottom-right of the application window.

import React from "react";
import { useToastStore } from "./useToastStore";
import type { ToastItem } from "./useToastStore";

const VARIANT_STYLES: Record<ToastItem["variant"], { bg: string; border: string; icon: string }> = {
  info:    { bg: "#f0f4ff", border: "#c0d0f0", icon: "\u24D8" },
  success: { bg: "#f0fff0", border: "#a0d0a0", icon: "\u2713" },
  warning: { bg: "#fffbf0", border: "#e0c880", icon: "\u26A0" },
  error:   { bg: "#fff0f0", border: "#e0a0a0", icon: "\u2717" },
};

function ToastItem({ toast }: { toast: ToastItem }): React.ReactElement {
  const removeToast = useToastStore((s) => s.removeToast);
  const style = VARIANT_STYLES[toast.variant];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 14px",
        backgroundColor: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
        fontSize: 13,
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#333",
        maxWidth: 380,
        lineHeight: 1.4,
        animation: "toastSlideIn 0.2s ease-out",
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0 }}>{style.icon}</span>
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button
        onClick={() => removeToast(toast.id)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          color: "#666",
          padding: "2px 6px",
          borderRadius: 3,
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLElement).style.backgroundColor = "#e0e0e0";
        }}
        onMouseLeave={(e) => {
          (e.target as HTMLElement).style.backgroundColor = "transparent";
        }}
      >
        OK
      </button>
    </div>
  );
}

export function ToastContainer(): React.ReactElement | null {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes toastSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        style={{
          position: "fixed",
          bottom: 36,
          right: 16,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "auto",
        }}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </>
  );
}
