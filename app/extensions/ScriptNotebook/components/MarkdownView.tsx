//! FILENAME: app/extensions/ScriptNotebook/components/MarkdownView.tsx
// PURPOSE: Render a notebook TEXT cell's markdown as React elements.
// CONTEXT: Deliberately renders to elements — there is no innerHTML anywhere in
//          this file, so a distributed .calp notebook whose prose contains
//          `<script>` or an `onerror=` attribute renders as literal text and
//          cannot execute. Link targets are restricted to http(s)/mailto for
//          the same reason (a `javascript:` href is dropped to plain text).
//          Subset supported: ATX headings, fenced + inline code, bullet and
//          numbered lists, blockquotes, thematic breaks, bold/italic, links.

import React from "react";

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

/** `code`, **bold**, *italic*, [text](href) — in that precedence order. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} style={styles.inlineCode}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      if (SAFE_LINK.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" style={styles.link}>
            {label}
          </a>,
        );
      } else {
        // Not a scheme we will hand to the OS — show the markdown verbatim.
        out.push(token);
      }
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Block layout
// ---------------------------------------------------------------------------

export function MarkdownView({ source }: { source: string }): React.ReactElement {
  const blocks: React.ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or fall off the end)
      blocks.push(
        <pre key={`b${key++}`} style={styles.pre} data-lang={lang || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Thematic break
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} style={styles.hr} />);
      i++;
      continue;
    }

    // Heading
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div key={`b${key++}`} style={{ ...styles.heading, ...headingSize(level) }}>
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines)
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={`b${key++}`} style={styles.quote}>
          {renderInline(quoted.join(" "), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Lists (bullet or ordered)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        const o = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        const match = isOrdered ? o : b;
        if (!match) break;
        items.push(match[1]);
        i++;
      }
      const children = items.map((item, n) => (
        <li key={n} style={styles.li}>
          {renderInline(item, `l${key}-${n}`)}
        </li>
      ));
      blocks.push(
        isOrdered ? (
          <ol key={`b${key++}`} style={styles.list}>
            {children}
          </ol>
        ) : (
          <ul key={`b${key++}`} style={styles.list}>
            {children}
          </ul>
        ),
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (consecutive non-blank, non-structural lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*(```|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) {
      blocks.push(
        <p key={`b${key++}`} style={styles.p}>
          {renderInline(para.join(" "), `p${key}`)}
        </p>,
      );
    }
  }

  return <div style={styles.root}>{blocks}</div>;
}

function headingSize(level: number): React.CSSProperties {
  const sizes = [17, 15, 14, 13, 12, 12];
  return { fontSize: `${sizes[level - 1] ?? 12}px` };
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    padding: "8px 10px",
    fontSize: "12px",
    lineHeight: "18px",
    color: "var(--text-primary, #333)",
    wordBreak: "break-word",
  },
  heading: {
    fontWeight: 600,
    margin: "8px 0 4px",
    color: "var(--text-primary, #222)",
  },
  p: { margin: "0 0 8px" },
  list: { margin: "0 0 8px", paddingLeft: "20px" },
  li: { margin: "2px 0" },
  quote: {
    margin: "0 0 8px",
    padding: "2px 0 2px 10px",
    borderLeft: "3px solid var(--border-color, #ddd)",
    color: "var(--text-secondary, #666)",
  },
  pre: {
    margin: "0 0 8px",
    padding: "6px 8px",
    background: "var(--toolbar-bg, #f5f5f5)",
    border: "1px solid var(--border-color, #e0e0e0)",
    borderRadius: "3px",
    overflowX: "auto",
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "11px",
  },
  inlineCode: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "11px",
    background: "var(--toolbar-bg, #f0f0f0)",
    borderRadius: "2px",
    padding: "0 3px",
  },
  hr: {
    border: "none",
    borderTop: "1px solid var(--border-color, #e0e0e0)",
    margin: "8px 0",
  },
  link: { color: "var(--accent-color, #0078d4)" },
};
