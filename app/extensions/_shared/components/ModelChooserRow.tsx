//! FILENAME: app/extensions/_shared/components/ModelChooserRow.tsx
// PURPOSE: Pick the AI model from wherever you are using AI, without going to
//          find the panel that owns the setting.
// CONTEXT: SHARED ON PURPOSE, and this location is the whole point. It first
//          lived inside the design-query folder, which would have made model
//          choice a feature of one dialog; it belongs to every AI surface. Today
//          that is the design query, the formula assistant, the script editor's
//          AI edits and the chat itself, and the list is expected to grow. A
//          component in `extensions/_shared/components` is reachable from all of
//          them and from any extension added later, while one inside a feature
//          folder is reachable from none — an extension may not import another
//          extension's internals.
//
//          IT DEPENDS ONLY ON `@api`. No AIChat import, no settings keys, no
//          knowledge of providers, credentials or downloads: it asks the
//          completion seam for a list and hands back a key. That is what lets it
//          sit anywhere, and it is why `listModels`/`selectModel` went on the
//          seam rather than being read out of AIChat's storage.
//
//          IT ASKS LAZILY. `listModels()` costs a loopback probe and one call
//          per keyed cloud provider; doing that on mount would put a round trip
//          behind every surface that merely DISPLAYS the current model. Nothing
//          is fetched until the list is opened — which is also the only moment
//          the answer can be trusted, since a runtime can start or stop in
//          between.
//
//          IT LISTS ONLY WHAT CAN ANSWER. Entering a key, downloading the
//          bundled model and running a probe need consent dialogs and credential
//          slots that live in the owning extension's own pane, and `_shared` has
//          no backend channel at all. So an empty list is a sentence plus a
//          button that raises that pane — never a dropdown of things that
//          cannot work, which is the "disabled control with no reason" failure
//          in a new hat.
//
//          THE CHOICE IS GLOBAL, and the caption says so out loud. It is one
//          application preference (owner decision 2026-09-14), so changing it
//          here changes it everywhere including the chat. Telling the person
//          costs one line; letting them discover it costs their trust in the
//          control.

import React, { useCallback, useState } from "react";
import { getAiCompletionProvider, type AiModelOption } from "@api";
import { TOKENS as T } from "../lib/themeTokens";

export interface ModelChooserRowProps {
  disabled?: boolean;
  /** Told when the selection changed, so a caption elsewhere can re-read it. */
  onChanged?: () => void;
  /** Shown on the closed button before the model name. Defaults to "Model:". */
  label?: string;
  /** Compact surfaces can drop the "changes it everywhere" line. */
  hideScopeNote?: boolean;
}

const toggleStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  borderRadius: 6,
  border: `1px solid ${T.border}`,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const listStyle: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  background: T.panelBg,
  padding: "6px 8px",
  marginTop: 4,
  maxHeight: 200,
  overflowY: "auto",
};

const noteStyle: React.CSSProperties = {
  fontSize: 11,
  color: T.textSecondary,
  margin: "4px 0 0",
  whiteSpace: "pre-wrap",
};

const metaStyle: React.CSSProperties = {
  fontSize: 11,
  color: T.textSecondary,
  fontWeight: 400,
};

export function ModelChooserRow({
  disabled,
  onChanged,
  label = "Model:",
  hideScopeNote,
}: ModelChooserRowProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<readonly AiModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = getAiCompletionProvider();

  const load = useCallback(async () => {
    const p = getAiCompletionProvider();
    if (!p) return;
    setLoading(true);
    setError(null);
    try {
      setModels(await p.listModels());
    } catch (e) {
      // A failure here is not a reason to hide the escape hatch: the person
      // still needs the button that opens the full picker.
      setError(e instanceof Error ? e.message : String(e));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (!wasOpen && models === null) void load();
      return !wasOpen;
    });
  }, [load, models]);

  const choose = useCallback(
    (key: string) => {
      const p = getAiCompletionProvider();
      if (!p) return;
      try {
        p.selectModel(key);
        setOpen(false);
        onChanged?.();
      } catch (e) {
        // `selectModel` throws on a key it did not issue. Saying so beats a
        // control that silently selected nothing.
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onChanged],
  );

  const openPicker = useCallback(() => {
    getAiCompletionProvider()?.openModelPicker();
    setOpen(false);
  }, []);

  if (!provider) return null;

  const current = provider.modelLabel();
  const selectedKey = provider.selectedModelKey();

  return (
    <div data-testid="model-chooser">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        style={{ ...toggleStyle, opacity: disabled ? 0.5 : 1 }}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid="model-chooser-toggle"
      >
        {current ? `${label} ${current}` : "Choose a model"}
        <span aria-hidden="true" style={{ marginLeft: 6, opacity: 0.7 }}>
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <div style={listStyle} role="listbox" data-testid="model-chooser-list">
          {loading ? (
            <div style={noteStyle} data-testid="model-chooser-loading">
              Looking for models that can answer…
            </div>
          ) : null}

          {error ? (
            <div style={{ ...noteStyle, color: T.dangerFg }} data-testid="model-chooser-error">
              {error}
            </div>
          ) : null}

          {!loading && models && models.length === 0 ? (
            <div style={noteStyle} data-testid="model-chooser-empty">
              No model can answer right now. A cloud model needs its key, a local
              runtime needs to be running, and the built-in model needs its
              one-time download.
            </div>
          ) : null}

          {models?.map((m) => {
            const isCurrent = m.key === selectedKey;
            return (
              <button
                key={m.key}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => choose(m.key)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "5px 6px",
                  border: "none",
                  borderRadius: 4,
                  background: isCurrent ? T.infoBg : "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 12,
                }}
                data-testid={isCurrent ? "model-chooser-option-current" : "model-chooser-option"}
              >
                <span style={{ fontWeight: isCurrent ? 600 : 400 }}>{m.model}</span>
                <span style={{ ...metaStyle, marginLeft: 6 }}>
                  {m.providerLabel}
                  {m.isLocal ? " · on this machine" : ""}
                  {/* Said out loud because a caller that sends a GBNF grammar
                      gets a different quality of answer from a runtime that
                      honours one — the design query names real columns under a
                      grammar and invents them without. */}
                  {m.honorsGrammar === true ? " · follows the query grammar" : ""}
                </span>
              </button>
            );
          })}

          {hideScopeNote ? null : (
            <div style={noteStyle}>Changing this changes the model everywhere in Calcula.</div>
          )}
          <button
            type="button"
            onClick={openPicker}
            style={{ ...toggleStyle, marginTop: 6 }}
            data-testid="model-chooser-open-picker"
          >
            Set up a model…
          </button>
        </div>
      ) : null}
    </div>
  );
}
