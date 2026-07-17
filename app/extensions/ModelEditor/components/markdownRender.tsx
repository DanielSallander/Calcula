// FILENAME: app/extensions/ModelEditor/components/markdownRender.tsx
// PURPOSE: The Model Editor's minimal Markdown renderer (headings, paragraphs,
//          code blocks, tables, lists, inline bold/italic/code/links) shared
//          by the function-reference pane and the CLI reference pane.
//          `NAME.md` links call the onNavigate callback for in-pane
//          navigation; the docs use exactly this subset.

import React from "react";
import { styles } from "./editorShared";

const codeBlock: React.CSSProperties = {
  background: "#f5f6f8",
  border: "1px solid #e3e5e8",
  borderRadius: 4,
  padding: "8px 10px",
  fontFamily: "Consolas, 'Cascadia Code', monospace",
  fontSize: 12,
  overflowX: "auto",
  whiteSpace: "pre",
  margin: "6px 0",
};
const inlineCode: React.CSSProperties = {
  background: "#eef0f2",
  borderRadius: 3,
  padding: "0 4px",
  fontFamily: "Consolas, 'Cascadia Code', monospace",
  fontSize: "0.92em",
};
export const linkStyle: React.CSSProperties = {
  color: "#2f6fce",
  cursor: "pointer",
  textDecoration: "none",
};

/** Split a Markdown table row `| a | b |` into trimmed cells. */
function tableCells(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render inline Markdown (bold, italic, code, links) to React nodes. */
function renderInline(text: string, onNavigate: (fn: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      const label = m[2];
      const target = m[3];
      const fn = /^([A-Za-z0-9_]+)\.md$/.exec(target);
      if (fn) {
        const name = fn[1];
        nodes.push(
          <a key={key++} style={linkStyle} onClick={() => onNavigate(name)} title={`Open ${name}`}>
            {label}
          </a>,
        );
      } else {
        // External / non-doc link: show the label (no navigation in the sandbox).
        nodes.push(
          <span key={key++} style={{ color: "#2f6fce" }}>
            {label}
          </span>,
        );
      }
    } else if (m[4]) {
      nodes.push(<strong key={key++}>{renderInline(m[5], onNavigate)}</strong>);
    } else if (m[6]) {
      nodes.push(
        <code key={key++} style={inlineCode}>
          {m[7]}
        </code>,
      );
    } else if (m[8]) {
      nodes.push(<em key={key++}>{renderInline(m[9], onNavigate)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render the docs' Markdown subset to React nodes. */
export function renderMarkdown(md: string, onNavigate: (fn: string) => void): React.ReactNode[] {
  const lines = md.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const isTableSep = (s: string): boolean => /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.includes("-");

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (line.trim().startsWith("```")) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key++} style={codeBlock}>
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }

    // Table (header row followed by a `---` separator).
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} style={{ overflowX: "auto", margin: "6px 0" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th
                    key={hi}
                    style={{
                      ...styles.th,
                      borderBottom: "2px solid #ddd",
                      background: "#f7f8fa",
                    }}
                  >
                    {renderInline(h, onNavigate)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={styles.td}>
                      {renderInline(c, onNavigate)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Headings.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const size = level === 1 ? 20 : level === 2 ? 15 : 13;
      blocks.push(
        <div
          key={key++}
          style={{
            fontSize: size,
            fontWeight: 600,
            color: "#222",
            margin: level === 1 ? "2px 0 8px" : "12px 0 4px",
            borderBottom: level <= 2 ? "1px solid #eee" : undefined,
            paddingBottom: level <= 2 ? 3 : 0,
          }}
        >
          {renderInline(h[2], onNavigate)}
        </div>,
      );
      i++;
      continue;
    }

    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ margin: "4px 0", paddingLeft: 20 }}>
          {items.map((it, idx) => (
            <li key={idx} style={{ margin: "2px 0" }}>
              {renderInline(it, onNavigate)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (join consecutive plain lines).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} style={{ margin: "4px 0", lineHeight: 1.5 }}>
        {renderInline(para.join(" "), onNavigate)}
      </p>,
    );
  }
  return blocks;
}
