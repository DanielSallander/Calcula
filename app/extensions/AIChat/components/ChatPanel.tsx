//! FILENAME: app/extensions/AIChat/components/ChatPanel.tsx
// PURPOSE: MCP Server control panel.
// CONTEXT: Allows users to start/stop the MCP server, configure port,
//          and see setup instructions for connecting AI clients.

import React, { useState, useEffect, useCallback } from "react";
import type { TaskPaneViewProps } from "@api";
import { invokeBackend } from "@api/backend";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
  padding: "12px",
  gap: 12,
  overflowY: "auto",
};

const headingStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "#333",
  margin: 0,
};

const sectionStyle: React.CSSProperties = {
  backgroundColor: "#FFF",
  border: "1px solid #E0E0E0",
  borderRadius: 6,
  padding: "12px 14px",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#444",
  margin: "0 0 8px 0",
};

const textStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#555",
  lineHeight: 1.5,
  margin: "0 0 6px 0",
};

const codeStyle: React.CSSProperties = {
  display: "block",
  backgroundColor: "#F5F5F5",
  border: "1px solid #DDD",
  borderRadius: 4,
  padding: "8px 10px",
  fontFamily: "Consolas, monospace",
  fontSize: 11,
  color: "#333",
  whiteSpace: "pre",
  overflowX: "auto",
  margin: "6px 0",
};

const statusDotStyle = (active: boolean): React.CSSProperties => ({
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: "50%",
  backgroundColor: active ? "#4CAF50" : "#CCC",
  marginRight: 8,
  flexShrink: 0,
});

const buttonStyle = (variant: "start" | "stop"): React.CSSProperties => ({
  padding: "6px 16px",
  fontSize: 12,
  fontWeight: 500,
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  color: "#FFF",
  backgroundColor: variant === "start" ? "#2196F3" : "#F44336",
});

const inputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 4,
  width: 70,
  backgroundColor: "#FFF",
  color: "#333",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#555",
  marginRight: 8,
};

const toolListStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  margin: "6px 0 0 0",
  paddingLeft: 16,
  lineHeight: 1.7,
};

const errorStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#D32F2F",
  margin: "4px 0 0 0",
};

// ============================================================================
// Component
// ============================================================================

interface McpStatus {
  running: boolean;
  port: number;
}

export function ChatPanel(_props: TaskPaneViewProps): React.ReactElement {
  const [status, setStatus] = useState<McpStatus>({ running: false, port: 8787 });
  const [portInput, setPortInput] = useState("8787");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Poll server status
  const refreshStatus = useCallback(async () => {
    try {
      const result = await invokeBackend<McpStatus>("mcp_status");
      setStatus(result);
      if (!loading) {
        setPortInput(String(result.port));
      }
    } catch {
      // Ignore — backend not ready
    }
  }, [loading]);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 3000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleStart = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      // Set port first if changed
      const port = parseInt(portInput, 10);
      if (port && port !== status.port && !status.running) {
        await invokeBackend("mcp_set_port", { port });
      }
      await invokeBackend("mcp_start");
      // Give server a moment to bind
      setTimeout(refreshStatus, 500);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [portInput, status.port, status.running, refreshStatus]);

  const handleStop = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      await invokeBackend("mcp_stop");
      setTimeout(refreshStatus, 500);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshStatus]);

  const configSnippet =
    '{\n' +
    '  "mcpServers": {\n' +
    '    "calcula": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["-y",\n' +
    '        "mcp-remote",\n' +
    `        "http://127.0.0.1:${status.port}/mcp"]\n` +
    '    }\n' +
    '  }\n' +
    '}';

  return React.createElement("div", { style: containerStyle },
    // Header
    React.createElement("h2", { style: headingStyle }, "MCP Server"),

    // Server Control
    React.createElement("div", { style: sectionStyle },
      React.createElement("h3", { style: sectionTitleStyle }, "Server Control"),

      // Status row
      React.createElement("div", {
        style: { display: "flex", alignItems: "center", marginBottom: 10 },
      },
        React.createElement("span", { style: statusDotStyle(status.running) }),
        React.createElement("span", {
          style: { fontSize: 13, fontWeight: 500, color: status.running ? "#2E7D32" : "#666" },
        }, status.running ? `Running on port ${status.port}` : "Stopped"),
      ),

      // Port + button row
      React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: 8 },
      },
        React.createElement("label", { style: labelStyle }, "Port:"),
        React.createElement("input", {
          type: "number",
          value: portInput,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPortInput(e.target.value),
          disabled: status.running,
          style: {
            ...inputStyle,
            opacity: status.running ? 0.5 : 1,
          },
          min: 1024,
          max: 65535,
        }),
        React.createElement("div", { style: { flex: 1 } }),
        status.running
          ? React.createElement("button", {
              onClick: handleStop,
              disabled: loading,
              style: buttonStyle("stop"),
            }, "Stop")
          : React.createElement("button", {
              onClick: handleStart,
              disabled: loading,
              style: buttonStyle("start"),
            }, "Start"),
      ),

      // Error message
      error ? React.createElement("p", { style: errorStyle }, error) : null,
    ),

    // Description
    React.createElement("div", { style: sectionStyle },
      React.createElement("h3", { style: sectionTitleStyle }, "What is MCP?"),
      React.createElement("p", { style: textStyle },
        "The Model Context Protocol (MCP) lets AI assistants interact with " +
        "your spreadsheet. Start the server and connect any MCP-compatible client:"
      ),
      React.createElement("ul", { style: toolListStyle },
        React.createElement("li", null, "Claude Desktop"),
        React.createElement("li", null, "Claude Code (VS Code)"),
        React.createElement("li", null, "Cursor"),
        React.createElement("li", null, "Any MCP-compatible AI client"),
      ),
    ),

    // Setup Instructions
    React.createElement("div", { style: sectionStyle },
      React.createElement("h3", { style: sectionTitleStyle }, "Client Configuration"),
      React.createElement("p", { style: textStyle },
        "Add this to your AI client's MCP configuration:"
      ),
      React.createElement("code", { style: codeStyle }, configSnippet),
    ),

    // Available Tools
    React.createElement("div", { style: sectionStyle },
      React.createElement("h3", { style: sectionTitleStyle }, "Available Tools"),
      React.createElement("ul", { style: toolListStyle },
        React.createElement("li", null,
          React.createElement("strong", null, "get_cell_range"),
          " - Read cell values and formulas"
        ),
        React.createElement("li", null,
          React.createElement("strong", null, "set_cell_value"),
          " - Write a single cell"
        ),
        React.createElement("li", null,
          React.createElement("strong", null, "set_cell_range"),
          " - Write multiple cells at once"
        ),
        React.createElement("li", null,
          React.createElement("strong", null, "get_sheet_summary"),
          " - AI-optimized workbook overview"
        ),
        React.createElement("li", null,
          React.createElement("strong", null, "apply_formatting"),
          " - Bold, colors, number formats"
        ),
        React.createElement("li", null,
          React.createElement("strong", null, "run_script"),
          " - Execute JavaScript automation"
        ),
      ),
    ),
  );
}
