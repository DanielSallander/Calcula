//! FILENAME: app/src/shell/RootErrorBoundary/RootErrorBoundary.tsx
// PURPOSE: The last thing standing between a render-time exception and a blank
//          white window.
// CONTEXT: Filed as BUG-0083 while answering "can a mount failure reach a real
//          user?" for BUG-0082.
//
//          There was NO error boundary anywhere in the frontend -- zero matches
//          for `componentDidCatch` / `getDerivedStateFromError` across
//          `app/src` and `app/extensions` -- across FIVE React roots (the main
//          window plus the Chart Spec Editor, Object Script Editor, Model
//          Editor and Application Inspector windows). React 18 unmounts the whole
//          tree when a render throws with no boundary above it, and every one
//          of those windows is `<div id="root"></div>` and nothing else. So the
//          user got a white window with no message.
//
//          In a browser that is merely bad. Under Tauri it is WORSE than bad:
//          there is no devtools in a production build and no address bar, so a
//          blank window is indistinguishable from a hung app. The one thing the
//          user could usefully do -- reload, or report what happened -- is the
//          one thing nothing told them was possible.
//
// ============================================================================
// THIS COMPONENT HAS NO DEPENDENCIES ON PURPOSE.
// ============================================================================
// It imports React and nothing else. No styled-components, no theme, no store,
// no `@api`. Every one of those is a plausible CAUSE of the error it is
// catching, and a fallback that renders through the broken subsystem is not a
// fallback. All styling is inline, all colours are literals, and the tree it
// renders is plain elements.

import React from "react";

export interface RootErrorBoundaryProps {
  /** Name of the window, so the message says WHICH one failed. */
  readonly surface: string;
  readonly children: React.ReactNode;
  /**
   * Called once when an error is caught. Injected rather than imported so the
   * boundary keeps its no-dependency promise and so tests can observe it.
   */
  readonly onError?: (error: Error, componentStack: string) => void;
}

interface RootErrorBoundaryState {
  readonly error: Error | null;
  readonly componentStack: string;
}

/** Everything a bug report needs, as one block of text the user can copy. */
export function formatFailureReport(
  surface: string,
  error: Error | null,
  componentStack: string,
): string {
  return [
    `Calcula - ${surface} failed to start`,
    `when:  ${new Date().toISOString()}`,
    `error: ${error ? `${error.name}: ${error.message}` : "(no error object)"}`,
    "",
    "stack:",
    error?.stack ?? "(none)",
    "",
    "component stack:",
    componentStack || "(none)",
  ].join("\n");
}

const SHELL_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  overflow: "auto",
  padding: "32px",
  boxSizing: "border-box",
  background: "#ffffff",
  color: "#1a1a1a",
  font: "14px/1.5 'Segoe UI', system-ui, sans-serif",
};

const HEADING_STYLE: React.CSSProperties = {
  margin: "0 0 8px",
  font: "600 20px/1.3 'Segoe UI', system-ui, sans-serif",
  color: "#a4262c",
};

const MESSAGE_STYLE: React.CSSProperties = {
  margin: "0 0 20px",
  maxWidth: "72ch",
};

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  marginBottom: "20px",
  flexWrap: "wrap",
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: "6px 16px",
  font: "14px/1.4 'Segoe UI', system-ui, sans-serif",
  color: "#ffffff",
  background: "#217346",
  border: "1px solid #1a5c38",
  borderRadius: "2px",
  cursor: "pointer",
};

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  color: "#1a1a1a",
  background: "#f3f2f1",
  border: "1px solid #8a8886",
};

const DETAILS_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "12px",
  overflow: "auto",
  maxHeight: "45vh",
  background: "#f3f2f1",
  border: "1px solid #d2d0ce",
  borderRadius: "2px",
  font: "12px/1.45 Consolas, 'Courier New', monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/**
 * Catches render-time exceptions under a React root and shows a legible failure
 * state instead of leaving the window blank.
 *
 * NOT a general-purpose recovery mechanism: React error boundaries do not catch
 * exceptions from event handlers, `setTimeout` callbacks, or rejected promises,
 * and none of those blank the window, which is the failure this exists for.
 */
export class RootErrorBoundary extends React.Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  public override state: RootErrorBoundaryState = { error: null, componentStack: "" };

  public static getDerivedStateFromError(error: Error): Partial<RootErrorBoundaryState> {
    return { error };
  }

  public override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    this.setState({ componentStack });
    // The console is the only sink guaranteed to exist here. It is also what a
    // developer and the E2E console tail both read.
    console.error(`[calcula] ${this.props.surface} failed to render`, error, componentStack);
    try {
      this.props.onError?.(error, componentStack);
    } catch {
      // A reporting hook that throws must not replace the message the user
      // needs with a second, more confusing failure.
    }
  }

  private readonly handleReload = (): void => {
    try {
      window.location.reload();
    } catch {
      // Nothing better to offer; the details are still on screen.
    }
  };

  private readonly handleCopy = (): void => {
    const report = formatFailureReport(
      this.props.surface,
      this.state.error,
      this.state.componentStack,
    );
    try {
      void navigator.clipboard?.writeText(report);
    } catch {
      // Clipboard access can be refused. The text is selectable on screen.
    }
  };

  public override render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;

    return (
      <div style={SHELL_STYLE} role="alert" data-testid="root-error-boundary">
        <h1 style={HEADING_STYLE}>{this.props.surface} could not start</h1>
        <p style={MESSAGE_STYLE}>
          Something went wrong while drawing this window, so Calcula stopped rather than
          showing you a blank screen. Your saved files are untouched. Reloading restarts
          this window only.
        </p>
        <div style={BUTTON_ROW_STYLE}>
          <button type="button" style={BUTTON_STYLE} onClick={this.handleReload}>
            Reload
          </button>
          <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={this.handleCopy}>
            Copy details
          </button>
        </div>
        <pre style={DETAILS_STYLE}>
          {formatFailureReport(this.props.surface, error, componentStack)}
        </pre>
      </div>
    );
  }
}
