// FILENAME: app/extensions/ModelEditor/components/SearchPalette.tsx
// PURPOSE: Ctrl+K — find any named object in the model and go to it.
// CONTEXT: This window had no search at all. On a 300-measure model the only
//          way to reach an object was to know which of twenty sections owned
//          it and then scroll. Both BI-developer reviews named this the single
//          biggest available win, and it is the one feature that makes the IA
//          question ("which section owns this?") stop mattering.
//
//          COMMAND MODE HANDS OFF; IT DOES NOT EXECUTE. Typing a CLI verb (or
//          a leading `>`) hands the text to the command line and opens it,
//          rather than running it here. That is deliberate: `planRun` gates a
//          multi-write behind a confirmation card that lives in the CLI panel,
//          and a palette that executed on Enter would either bypass that gate
//          or grow a second copy of it. One executor, one confirmation.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOverview } from "@api";
import { FONT, ME, MOTION, RADIUS, SHADOW, SPACE, TABULAR } from "./theme";
import { styles } from "./editorShared";
import type { SectionId } from "./editorShared";
import { buildModelIndex, groupByKind, KIND_LABEL, searchIndex } from "../lib/modelIndex";
import type { ScoredEntry } from "../lib/modelIndex";
import { VERBS } from "../cli/parse";

/** Verbs that flip the input into command mode without a `>` prefix. */
const VERB_WORDS = new Set<string>(VERBS as unknown as string[]);

/** Does this look like a command rather than a name to find? */
export function looksLikeCommand(raw: string): boolean {
  const q = raw.trim();
  if (q.startsWith(">")) return true;
  const first = q.split(/\s+/)[0]?.toLowerCase() ?? "";
  // A bare verb with nothing after it is far more likely to be someone
  // searching for the WORD ("show", "test") than issuing a command, so command
  // mode needs a verb AND an argument.
  return VERB_WORDS.has(first) && /\s/.test(q);
}

/** Strip the optional `>` so the CLI sees a clean command. */
export function commandTextOf(raw: string): string {
  const q = raw.trim();
  return q.startsWith(">") ? q.slice(1).trim() : q;
}

export function SearchPalette({
  overview,
  onNavigate,
  onRunCommand,
  onClose,
}: {
  overview: ModelOverview | null;
  onNavigate: (section: SectionId, selection?: string) => void;
  /** Hand a command to the CLI panel (opens it, prefilled). */
  onRunCommand: (text: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Built once per model, not per keystroke: on a big model this is thousands
  // of entries and rebuilding it while typing is what makes a palette feel slow.
  const index = useMemo(() => buildModelIndex(overview), [overview]);

  const commandMode = looksLikeCommand(query);
  const results = useMemo(
    () => (commandMode ? [] : searchIndex(index, query)),
    [index, query, commandMode],
  );
  const groups = useMemo(() => groupByKind(results), [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => inputRef.current?.focus(), []);

  // Keep the active index inside the result set as the query narrows. Adjusted
  // during render rather than in an effect (this config bans setState there).
  if (active > 0 && active >= flat.length) setActive(flat.length === 0 ? 0 : flat.length - 1);

  const choose = useCallback(
    (item: ScoredEntry | undefined) => {
      if (!item) return;
      onNavigate(item.entry.section, item.entry.selection);
      onClose();
    },
    [onNavigate, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (commandMode) {
        onRunCommand(commandTextOf(query));
        onClose();
        return;
      }
      choose(flat[active]);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const next =
        e.key === "ArrowDown"
          ? (active + 1) % flat.length
          : (active - 1 + flat.length) % flat.length;
      setActive(next);
      listRef.current
        ?.querySelector(`[data-palette-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };

  let cursor = -1;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: ME.scrim,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the model"
        data-testid="search-palette"
        style={{
          width: 640,
          maxWidth: "92vw",
          background: ME.overlay,
          borderRadius: RADIUS.panel,
          boxShadow: SHADOW.modal,
          display: "flex",
          flexDirection: "column",
          maxHeight: "70vh",
          overflow: "hidden",
          animation: `me-palette-in ${MOTION.overlay}`,
        }}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          data-testid="palette-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Find a table, measure, column…   or type a command"
          aria-label="Search the model"
          style={{
            ...styles.input,
            border: "none",
            borderRadius: 0,
            borderBottom: `1px solid ${ME.borderSubtle}`,
            fontSize: FONT.sectionTitle,
            padding: `${SPACE.lg}px ${SPACE.xl}px`,
            background: "transparent",
            outline: "none",
          }}
        />

        {commandMode ? (
          <div style={{ padding: SPACE.xl, color: ME.text2, fontSize: FONT.base }}>
            <div style={{ marginBottom: SPACE.sm }}>
              Press <kbd>Enter</kbd> to open this in the command line:
            </div>
            <div
              style={{
                fontFamily: ME.mono,
                fontSize: FONT.base,
                background: ME.sunken,
                borderRadius: RADIUS.control,
                padding: `${SPACE.sm}px ${SPACE.md}px`,
                color: ME.text,
                wordBreak: "break-all",
              }}
            >
              {commandTextOf(query)}
            </div>
            <div style={{ ...styles.hint, marginTop: SPACE.sm }}>
              It opens there rather than running here, so a multi-object edit still shows you
              what it will touch before it runs.
            </div>
          </div>
        ) : query.trim() === "" ? (
          <div style={{ padding: SPACE.xl, color: ME.text3, fontSize: FONT.sm }}>
            Type to search {index.length.toLocaleString()} objects. Narrow with{" "}
            <code style={{ fontFamily: ME.mono }}>measure:</code>,{" "}
            <code style={{ fontFamily: ME.mono }}>table:</code>,{" "}
            <code style={{ fontFamily: ME.mono }}>column:</code>, or a qualified reference like{" "}
            <code style={{ fontFamily: ME.mono }}>Fact_Sales[Margin]</code>.
          </div>
        ) : flat.length === 0 ? (
          <div style={{ padding: SPACE.xl, color: ME.text3, fontSize: FONT.sm }}>
            Nothing matches “{query.trim()}”.
          </div>
        ) : (
          <div ref={listRef} style={{ overflowY: "auto", padding: SPACE.xs }}>
            {groups.map((group) => (
              <div key={group.kind}>
                <div
                  style={{
                    padding: `${SPACE.sm}px ${SPACE.md}px ${SPACE.xs}px`,
                    fontSize: FONT.xs,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: ME.text3,
                  }}
                >
                  {KIND_LABEL[group.kind]}
                  <span style={{ ...TABULAR, marginLeft: SPACE.sm, fontWeight: 400 }}>
                    {group.items.length}
                  </span>
                </div>
                {group.items.map((item) => {
                  cursor += 1;
                  const i = cursor;
                  const isActive = i === active;
                  return (
                    <div
                      key={`${item.entry.kind}:${item.entry.name}:${item.entry.context ?? ""}`}
                      data-palette-index={i}
                      data-testid="palette-result"
                      role="button"
                      tabIndex={-1}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(item);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: SPACE.sm,
                        padding: `${SPACE.sm}px ${SPACE.md}px`,
                        borderRadius: RADIUS.control,
                        cursor: "pointer",
                        background: isActive ? ME.select : "transparent",
                      }}
                    >
                      <span style={{ color: ME.text, fontSize: FONT.base }}>
                        {highlight(item.entry.name, item.hits)}
                      </span>
                      {item.entry.context && (
                        <span style={{ color: ME.text3, fontSize: FONT.sm }}>
                          {item.entry.context}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Bold the characters that matched, so a fuzzy hit explains itself. */
function highlight(name: string, hits: number[]): React.ReactNode {
  if (hits.length === 0) return name;
  const set = new Set(hits);
  const out: React.ReactNode[] = [];
  let run = "";
  let runHit = set.has(0);
  for (let i = 0; i < name.length; i++) {
    const hit = set.has(i);
    if (hit !== runHit && run) {
      out.push(
        runHit ? (
          <strong key={i} style={{ color: ME.accent }}>
            {run}
          </strong>
        ) : (
          <span key={i}>{run}</span>
        ),
      );
      run = "";
    }
    runHit = hit;
    run += name[i];
  }
  if (run) {
    out.push(
      runHit ? (
        <strong key="last" style={{ color: ME.accent }}>
          {run}
        </strong>
      ) : (
        <span key="last">{run}</span>
      ),
    );
  }
  return out;
}
