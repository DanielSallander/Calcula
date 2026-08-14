// FILENAME: app/extensions/ModelEditor/cli/modelDomain.ts
// PURPOSE: The MODEL domain of the fused Calcula CLI — packages this
//          directory's readers/writers/help behind the shared kernel's
//          CliDomain contract (_shared/cli/registry.ts). The vocabulary is
//          the SAME contribution object parse.ts builds its standalone parser
//          from, so fused and standalone parsing can never disagree.
// CONTEXT: The batch strategy is the model's TRUE rollback: bi_model_batch_*
//          = one undo snapshot, batchCancel reinstalls it (all-or-nothing).

import type { GenericCommand } from "../../_shared/cli/parse";
import type { CliDomain, CliIo, WritePreview } from "../../_shared/cli/registry";
import type { CliSession } from "./execute";
import { asModelCommand, MODEL_KIND_DATA, MODEL_VOCABULARY_CONTRIBUTION } from "./parse";
import { MODEL_OPTION_TABLES, validateModelOptions } from "./modelOptions";
import { modelNameSuggestions } from "./modelCompletion";
import { runRead } from "./readers";
import { previewWriteCommand, runWrite } from "./writers";
import { helpText } from "./help";

/** The verbs the model answers as reads (everything else it owns mutates). */
const MODEL_READ_VERBS: ReadonlySet<string> = new Set(["ls", "show", "validate"]);

export function createModelDomain(): CliDomain<CliSession> {
  return {
    id: "model",
    label: "model",
    // The SAME kind data parse.ts builds its vocabulary from, with each
    // kind's audited option table attached (drives strict validation,
    // completion and help through the kernel's CliKindSpec contract) and live
    // name suggestions from the bound session's overview (the main-window
    // panel's generic completion reads these; the editor window's own panel
    // uses cliLanguage.ts, which shares modelNameSuggestions).
    kinds: MODEL_KIND_DATA.map((k) => ({
      ...k,
      options: MODEL_OPTION_TABLES[k.kind],
      nameSuggestions: (s: CliSession) => modelNameSuggestions(s.overview, k.kind),
    })),
    verbs: MODEL_VOCABULARY_CONTRIBUTION.verbs,
    pluralOverrides: MODEL_VOCABULARY_CONTRIBUTION.pluralOverrides,
    readVerbs: MODEL_READ_VERBS,
    strictOptions: true,

    async runRead(cmd: GenericCommand, s: CliSession, io: CliIo): Promise<void> {
      // Reads stay lenient: the audit found ls/show/validate consume NO
      // options (positional-only), so there is nothing to validate here.
      await runRead(asModelCommand(cmd), s, io);
    },

    previewWrite(cmd: GenericCommand, s: CliSession): WritePreview | null {
      const c = asModelCommand(cmd);
      validateModelOptions(c);
      return previewWriteCommand(c, s);
    },

    async runWrite(cmd: GenericCommand, s: CliSession, io: CliIo): Promise<void> {
      const c = asModelCommand(cmd);
      validateModelOptions(c);
      await runWrite(c, s, io);
    },

    isWritable(s: CliSession): boolean {
      return !s.readOnly;
    },

    batch: {
      confirmNote: "one undo step, all-or-nothing",
      async begin(s: CliSession): Promise<void> {
        // Persistent sessions (the main-window binding) reuse one CliSession
        // across runs; hadEdits is per-BATCH bookkeeping, so it resets here.
        s.hadEdits = false;
        await s.gateway.batchBegin(s.connectionId);
      },
      async end(s: CliSession): Promise<void> {
        await s.gateway.batchEnd(s.connectionId, s.hadEdits);
      },
      async onError(s: CliSession): Promise<"rolled-back" | "kept-partial"> {
        const restored = await s.gateway.batchCancel(s.connectionId);
        s.overview = restored;
        s.rolledBack = true;
        return "rolled-back";
      },
    },

    undoRedo: {
      async undo(s: CliSession, io: CliIo): Promise<void> {
        s.overview = await s.gateway.undo(s.connectionId);
        s.overviewDirty = true;
        io.print("Undone.", "info");
      },
      async redo(s: CliSession, io: CliIo): Promise<void> {
        s.overview = await s.gateway.redo(s.connectionId);
        s.overviewDirty = true;
        io.print("Redone.", "info");
      },
    },

    helpText(topic: string[]): string | null {
      return helpText(topic);
    },
  };
}
