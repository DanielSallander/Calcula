//! FILENAME: app/extensions/TestRunner/components/TestRunnerPane.tsx
// PURPOSE: Task pane UI for displaying test results.
// CONTEXT: Shows pass/fail status, durations, and error details.

import React, { useState, useEffect, useCallback } from "react";
import styled from "styled-components";
import type { TaskPaneViewProps } from "../../../src/api";
import { showToast } from "../../../src/api";
import type { SuiteResult, TestResult } from "../lib/types";
import {
  getResults,
  onResultsChange,
  runAllSuites,
  getRegisteredSuites,
  runSuiteByName,
} from "../lib/runner";
import { formatResultsForClipboard } from "../lib/formatter";

// ============================================================================
// Styles
// ============================================================================

const Container = styled.div`
  padding: 8px;
  font-size: 12px;
  font-family: "Segoe UI", sans-serif;
  height: 100%;
  overflow-y: auto;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
`;

const RunButton = styled.button`
  padding: 4px 12px;
  background: #0078d4;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  &:hover {
    background: #106ebe;
  }
  &:disabled {
    background: #999;
    cursor: default;
  }
`;

const CopyButton = styled.button`
  padding: 4px 10px;
  background: #f0f0f0;
  color: #333;
  border: 1px solid #ccc;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  &:hover {
    background: #e0e0e0;
  }
`;

const SuiteBlock = styled.div`
  margin-bottom: 12px;
`;

const SuiteHeader = styled.div`
  font-weight: 600;
  padding: 4px 0;
  cursor: pointer;
  user-select: none;
  &:hover {
    text-decoration: underline;
  }
`;

const TestRow = styled.div<{ $status: string }>`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 0 2px 12px;
  color: ${(p) =>
    p.$status === "pass"
      ? "#107c10"
      : p.$status === "fail"
        ? "#d83b01"
        : p.$status === "error"
          ? "#a80000"
          : "#666"};
`;

const StatusTag = styled.span<{ $status: string }>`
  font-weight: 600;
  font-size: 11px;
  min-width: 48px;
`;

const Duration = styled.span`
  color: #888;
  font-size: 11px;
  margin-left: auto;
  white-space: nowrap;
`;

const ErrorDetail = styled.div`
  padding: 2px 0 4px 56px;
  color: #a80000;
  font-size: 11px;
  font-style: italic;
  word-break: break-word;
`;

const Summary = styled.div`
  margin-top: 8px;
  padding: 6px 8px;
  background: #f5f5f5;
  border-radius: 3px;
  font-size: 11px;
`;

const EmptyState = styled.div`
  color: #888;
  padding: 20px 0;
  text-align: center;
`;

// ============================================================================
// Component
// ============================================================================

export const TestRunnerPane: React.FC<TaskPaneViewProps> = () => {
  const [results, setResults] = useState<SuiteResult[]>(getResults());
  const [running, setRunning] = useState(false);
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());

  useEffect(() => {
    return onResultsChange(() => {
      setResults([...getResults()]);
    });
  }, []);

  const handleRunAll = useCallback(async () => {
    setRunning(true);
    try {
      await runAllSuites();
      // Expand all suites after running
      const names = getRegisteredSuites().map((s) => s.name);
      setExpandedSuites(new Set(names));
    } finally {
      setRunning(false);
    }
  }, []);

  const handleRunSuite = useCallback(async (name: string) => {
    setRunning(true);
    try {
      await runSuiteByName(name);
    } finally {
      setRunning(false);
    }
  }, []);

  const toggleSuite = useCallback((name: string) => {
    setExpandedSuites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const handleCopyResults = useCallback(async () => {
    if (results.length === 0) return;
    const text = formatResultsForClipboard(results);
    try {
      await navigator.clipboard.writeText(text);
      showToast("Results copied to clipboard", { variant: "success" });
    } catch {
      // Fallback for environments where clipboard API is restricted
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      showToast("Results copied to clipboard", { variant: "success" });
    }
  }, [results]);

  const suites = getRegisteredSuites();
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  const totalMs = results.reduce((s, r) => s + r.totalMs, 0);

  const statusTag = (status: string) => {
    if (status === "pass") return "[PASS]";
    if (status === "fail") return "[FAIL]";
    if (status === "error") return "[ERROR]";
    return "[SKIP]";
  };

  return (
    <Container>
      <Header>
        <RunButton onClick={handleRunAll} disabled={running}>
          {running ? "Running..." : "Run All Tests"}
        </RunButton>
        {results.length > 0 && (
          <CopyButton onClick={handleCopyResults} title="Copy results formatted for AI prompt">
            Copy
          </CopyButton>
        )}
        <span style={{ color: "#888" }}>{suites.length} suite(s) registered</span>
      </Header>

      {results.length === 0 && (
        <EmptyState>No results yet. Click &quot;Run All Tests&quot; to start.</EmptyState>
      )}

      {results.map((suite) => (
        <SuiteBlock key={suite.suiteName}>
          <SuiteHeader onClick={() => toggleSuite(suite.suiteName)}>
            {expandedSuites.has(suite.suiteName) ? "v " : "> "}
            {suite.suiteName}
            {" "}({suite.passed}/{suite.results.length} passed)
            <RunButton
              style={{ marginLeft: 8, padding: "2px 8px", fontSize: 11 }}
              onClick={(e) => {
                e.stopPropagation();
                handleRunSuite(suite.suiteName);
              }}
              disabled={running}
            >
              Run
            </RunButton>
          </SuiteHeader>
          {expandedSuites.has(suite.suiteName) &&
            suite.results.map((test: TestResult, i: number) => (
              <React.Fragment key={i}>
                <TestRow $status={test.status}>
                  <StatusTag $status={test.status}>{statusTag(test.status)}</StatusTag>
                  <span>{test.name}</span>
                  <Duration>{test.durationMs.toFixed(0)}ms</Duration>
                </TestRow>
                {test.error && <ErrorDetail>{test.error}</ErrorDetail>}
              </React.Fragment>
            ))}
        </SuiteBlock>
      ))}

      {results.length > 0 && (
        <Summary>
          Total: {totalPassed} passed, {totalFailed} failed, {totalErrors} errors ({totalMs.toFixed(0)}ms)
        </Summary>
      )}
    </Container>
  );
};
