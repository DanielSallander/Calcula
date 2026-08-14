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
import { asModelCommand, MODEL_VOCABULARY_CONTRIBUTION } from "./parse";
import { runRead } from "./readers";
import { previewWriteCommand, runWrite } from "./writers";
import { helpText } from "./help";

/** The verbs the model answers as reads (everything else it owns mutates). */
const MODEL_READ_VERBS: ReadonlySet<string> = new Set(["ls", "show", "validate"]);

export function createModelDomain(): CliDomain<CliSession> {
  return {
    id: "model",
    label: "model",
    kinds: MODEL_VOCABULARY_CONTRIBUTION.kinds.map((k) => ({ ...k })),
    verbs: MODEL_VOCABULARY_CONTRIBUTION.verbs,
    pluralOverrides: MODEL_VOCABULARY_CONTRIBUTION.pluralOverrides,
    readVerbs: MODEL_READ_VERBS,

    async runRead(cmd: GenericCommand, s: CliSession, io: CliIo): Promise<void> {
      await runRead(asModelCommand(cmd), s, io);
    },

    previewWrite(cmd: GenericCommand, s: CliSession): WritePreview | null {
      return previewWriteCommand(asModelCommand(cmd), s);
    },

    async runWrite(cmd: GenericCommand, s: CliSession, io: CliIo): Promise<void> {
      await runWrite(asModelCommand(cmd), s, io);
    },

    isWritable(s: CliSession): boolean {
      return !s.readOnly;
    },

    batch: {
      confirmNote: "one undo step, all-or-nothing",
      async begin(s: CliSession): Promise<void> {
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
