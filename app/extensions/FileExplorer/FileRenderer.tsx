//! FILENAME: app/extensions/FileExplorer/FileRenderer.tsx
// PURPOSE: Renders file content based on file type (markdown, CSV, plain text)
// CONTEXT: Used by both the side panel preview and the Task Pane file viewer

import React, { useMemo } from "react";

const h = React.createElement;

// ============================================================================
// Markdown Renderer
// ============================================================================

/** Parses inline markdown: bold, italic, code, links, images */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Image: ![alt](url)
    let match = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (match) {
      nodes.push(h("img", {
        key: key++,
        src: match[2],
        alt: match[1],
        style: { maxWidth: "100%", borderRadius: 4 },
      }));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Link: [text](url)
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      nodes.push(h("a", {
        key: key++,
        href: match[2],
        target: "_blank",
        rel: "noopener",
        style: { color: "#007acc", textDecoration: "underline" },
      }, match[1]));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code: `code`
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      nodes.push(h("code", {
        key: key++,
        style: {
          backgroundColor: "#f0f0f0",
          padding: "1px 4px",
          borderRadius: 3,
          fontSize: "0.9em",
          fontFamily: "'Cascadia Code', 'Consolas', monospace",
        },
      }, match[1]));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Bold+Italic: ***text*** or ___text___
    match = remaining.match(/^(\*\*\*|___)(.+?)\1/);
    if (match) {
      nodes.push(h("strong", { key: key++ },
        h("em", null, ...renderInline(match[2]))
      ));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Bold: **text** or __text__
    match = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (match) {
      nodes.push(h("strong", { key: key++ }, ...renderInline(match[2])));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic: *text* or _text_
    match = remaining.match(/^(\*|_)(.+?)\1/);
    if (match) {
      nodes.push(h("em", { key: key++ }, ...renderInline(match[2])));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Strikethrough: ~~text~~
    match = remaining.match(/^~~(.+?)~~/);
    if (match) {
      nodes.push(h("del", { key: key++ }, ...renderInline(match[1])));
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Plain text: consume until next special char
    match = remaining.match(/^[^[!`*_~]+/);
    if (match) {
      nodes.push(match[0]);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Single special char that didn't match a pattern
    nodes.push(remaining[0]);
    remaining = remaining.slice(1);
  }

  return nodes;
}

interface MdBlock {
  type: "heading" | "paragraph" | "code" | "blockquote" | "ul" | "ol" | "hr" | "blank";
  level?: number;       // heading level (1-6), or list nesting
  content?: string;
  lines?: string[];     // for code blocks and list items
  lang?: string;        // code block language
}

/** Parse markdown text into blocks */
function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      const lang = codeMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", lines: codeLines, lang });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, content: headingMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)(\s*)$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", content: quoteLines.join("\n") });
      continue;
    }

    // Unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && (/^[\s]*[-*+]\s/.test(lines[i]) || /^\s{2,}/.test(lines[i]))) {
        listLines.push(lines[i].replace(/^[\s]*[-*+]\s/, ""));
        i++;
      }
      blocks.push({ type: "ul", lines: listLines });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && (/^[\s]*\d+\.\s/.test(lines[i]) || /^\s{2,}/.test(lines[i]))) {
        listLines.push(lines[i].replace(/^[\s]*\d+\.\s/, ""));
        i++;
      }
      blocks.push({ type: "ol", lines: listLines });
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("> ") &&
      !/^[-*+]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !/^(---|\*\*\*|___)(\s*)$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", content: paraLines.join("\n") });
  }

  return blocks;
}

/** Render parsed markdown blocks to React elements */
function renderBlocks(blocks: MdBlock[]): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const tag = `h${block.level}` as keyof JSX.IntrinsicElements;
        const sizes: Record<number, number> = { 1: 20, 2: 17, 3: 14, 4: 13, 5: 12, 6: 11 };
        elements.push(h(tag, {
          key: key++,
          style: {
            fontSize: sizes[block.level!] || 14,
            fontWeight: block.level! <= 2 ? 700 : 600,
            margin: "12px 0 6px 0",
            lineHeight: "1.3",
            color: "#222",
            borderBottom: block.level! <= 2 ? "1px solid #e8e8e8" : undefined,
            paddingBottom: block.level! <= 2 ? 4 : undefined,
          },
        }, ...renderInline(block.content!)));
        break;
      }

      case "paragraph":
        elements.push(h("p", {
          key: key++,
          style: { margin: "6px 0", lineHeight: "1.6" },
        }, ...renderInline(block.content!)));
        break;

      case "code":
        elements.push(h("pre", {
          key: key++,
          style: {
            backgroundColor: "#1e1e1e",
            color: "#d4d4d4",
            padding: "10px 12px",
            borderRadius: 4,
            margin: "8px 0",
            fontSize: 11,
            lineHeight: "1.5",
            overflow: "auto",
            fontFamily: "'Cascadia Code', 'Consolas', monospace",
          },
        }, h("code", null, block.lines!.join("\n"))));
        break;

      case "blockquote":
        elements.push(h("blockquote", {
          key: key++,
          style: {
            borderLeft: "3px solid #007acc",
            margin: "8px 0",
            padding: "4px 12px",
            color: "#555",
            backgroundColor: "#f8f9fa",
            borderRadius: "0 4px 4px 0",
          },
        }, ...renderBlocks(parseMarkdown(block.content!))));
        break;

      case "ul":
        elements.push(h("ul", {
          key: key++,
          style: { margin: "6px 0", paddingLeft: 20 },
        }, block.lines!.map((item, idx) =>
          h("li", { key: idx, style: { lineHeight: "1.6" } }, ...renderInline(item))
        )));
        break;

      case "ol":
        elements.push(h("ol", {
          key: key++,
          style: { margin: "6px 0", paddingLeft: 20 },
        }, block.lines!.map((item, idx) =>
          h("li", { key: idx, style: { lineHeight: "1.6" } }, ...renderInline(item))
        )));
        break;

      case "hr":
        elements.push(h("hr", {
          key: key++,
          style: { border: "none", borderTop: "1px solid #ddd", margin: "12px 0" },
        }));
        break;

      case "blank":
        // skip
        break;
    }
  }

  return elements;
}

// ============================================================================
// Public Components
// ============================================================================

/** Rendered markdown view (read-only) */
export function MarkdownView({ content }: { content: string }): React.ReactElement {
  const rendered = useMemo(() => {
    const blocks = parseMarkdown(content);
    return renderBlocks(blocks);
  }, [content]);

  return h("div", { style: mdStyles.container }, ...rendered);
}

const mdStyles: Record<string, React.CSSProperties> = {
  container: {
    fontSize: 12,
    lineHeight: "1.6",
    color: "#333",
    wordBreak: "break-word" as const,
  },
};

// ============================================================================
// File type detection
// ============================================================================

export type FileViewMode = "text" | "markdown";

export function getViewMode(ext: string): FileViewMode {
  switch (ext.toLowerCase()) {
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    default:
      return "text";
  }
}
