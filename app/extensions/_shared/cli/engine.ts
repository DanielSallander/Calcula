// FILENAME: app/extensions/_shared/cli/engine.ts
// PURPOSE: The fused CLI's run orchestration: parse a run against the merged
//          vocabulary, dispatch each command to its owning domain, preview
//          writes for the confirmation card, then execute sequentially with
//          the write domain's own atomicity strategy (the model's true
//          rollback vs the grid's commit-partial-as-one-undo-step).
// CONTEXT: One engine per window, built from the domains available there —
//          model-editor window: model; main window: app (+ model later).
//          Dispatch is kind-driven (kinds are globally unique); a kindless
//          verb goes to its only contributor, else the window's default
//          domain. A run may READ across domains but WRITE in only one:
//          separate undo systems make a cross-domain atomic run a lie, so it
//          is refused at plan time (owner decision, 2026-08-13).

import { CliError } from "./lex";
import { createParser } from "./parse";
import type { CliParser, GenericCommand } from "./parse";
import { buildVocabulary, kindOwners } from "./registry";
import type { CliDomainBinding, CliIo } from "./registry";

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlannedCommand {
  cmd: GenericCommand;
  /** The domain executing it; null = engine-level (help / clear). */
  binding: CliDomainBinding | null;
  /** How the owning side runs it. */
  route: "help" | "clear" | "undo" | "redo" | "read" | "write";
}

export interface RunPlan {
  items: PlannedCommand[];
  /** One label per planned write (wildcards expanded against the CURRENT
   *  session state). */
  writeLabels: string[];
  hasWildcard: boolean;
  /** Confirmation required before executing (multi-write or wildcard). */
  needsConfirm: boolean;
  /** The single domain all writes belong to (null = read-only run). */
  writeBinding: CliDomainBinding | null;
  /** The write domain's confirm-card wording, when a batch will be used. */
  confirmNote: string | null;
}

export interface RunOutcome {
  ok: boolean;
  /** True when any write command actually executed. */
  hadWrites: boolean;
}

export interface CliEngine {
  parser: CliParser;
  bindings: CliDomainBinding[];
  defaultBinding: CliDomainBinding;
  planRun(text: string): RunPlan;
  executeRun(plan: RunPlan, io: CliIo): Promise<RunOutcome>;
  /** Merged help: the default domain first, then the others. */
  helpText(topic: string[]): string;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createCliEngine(
  bindings: CliDomainBinding[],
  defaultDomainId: string,
): CliEngine {
  if (bindings.length === 0) throw new Error("A CLI engine needs at least one domain");
  const defaultBinding =
    bindings.find((b) => b.domain.id === defaultDomainId) ?? bindings[0];
  const parser = createParser(buildVocabulary(bindings));
  const byKind = kindOwners(bindings);

  /** Domains contributing a verb (core verbs count for every domain). */
  const verbContributors = (verb: string): CliDomainBinding[] => {
    const contributors = bindings.filter((b) =>
      (b.domain.verbs ?? []).some((v) => v.verb === verb),
    );
    return contributors.length > 0 ? contributors : bindings;
  };

  const routeFor = (b: CliDomainBinding, cmd: GenericCommand): "read" | "write" =>
    b.domain.readVerbs.has(cmd.verb) ? "read" : "write";

  const dispatch = (cmd: GenericCommand): PlannedCommand => {
    if (cmd.verb === "help") return { cmd, binding: null, route: "help" };
    if (cmd.verb === "clear") return { cmd, binding: null, route: "clear" };
    if (cmd.verb === "undo" || cmd.verb === "redo") {
      if (!defaultBinding.domain.undoRedo) {
        throw new CliError(
          `'${cmd.verb}' is not available here`,
          cmd.line,
        );
      }
      return { cmd, binding: defaultBinding, route: cmd.verb };
    }
    if (cmd.kind !== null) {
      const owner = byKind.get(cmd.kind);
      if (!owner) throw new CliError(`No domain owns kind '${cmd.kind}'`, cmd.line);
      return { cmd, binding: owner, route: routeFor(owner, cmd) };
    }
    const contributors = verbContributors(cmd.verb);
    if (contributors.length === 1) {
      return { cmd, binding: contributors[0], route: routeFor(contributors[0], cmd) };
    }
    if (contributors.includes(defaultBinding)) {
      return { cmd, binding: defaultBinding, route: routeFor(defaultBinding, cmd) };
    }
    throw new CliError(
      `'${cmd.verb}' is ambiguous here — name an object kind`,
      cmd.line,
    );
  };

  const helpText = (topic: string[]): string => {
    // A topic that names another domain's kind gets that domain's help.
    if (topic.length > 0) {
      const kind = parser.normalizeKind(topic[0]);
      const owner = kind ? byKind.get(kind) : undefined;
      if (owner && owner !== defaultBinding) {
        const t = owner.domain.helpText(topic);
        if (t !== null) return t;
      }
    }
    for (const b of [defaultBinding, ...bindings.filter((x) => x !== defaultBinding)]) {
      const t = b.domain.helpText(topic);
      if (t !== null) return t;
    }
    return `No help for '${topic.join(" ")}'.`;
  };

  const planRun = (text: string): RunPlan => {
    const commands = parser.parseScript(text);
    if (commands.length === 0) throw new CliError("Nothing to run");

    const undoRedo = commands.filter((c) => c.verb === "undo" || c.verb === "redo");
    if (undoRedo.length > 0 && commands.length > 1) {
      throw new CliError(
        "undo/redo must be run on their own (a batched script would swallow the step they restore)",
        undoRedo[0].line,
      );
    }

    const items = commands.map(dispatch);

    // A `where` clause NARROWS a command. A domain that parses it but cannot
    // evaluate it would run the un-narrowed command instead — so
    // `delete measure * where folder="Archive"` would delete every measure and
    // report success. Refuse before anything is planned, let alone previewed.
    for (const item of items) {
      if (!item.cmd.where || item.cmd.where.length === 0) continue;
      if (!item.binding?.domain.supportsWhere) {
        throw new CliError(
          `\`where\` is not supported${
            item.binding ? ` by ${item.binding.domain.label} commands` : " here"
          } — remove it rather than relying on it being ignored, which would ` +
            `widen this command to everything the pattern matches`,
          item.cmd.line,
        );
      }
    }

    const writeLabels: string[] = [];
    let hasWildcard = false;
    let writeBinding: CliDomainBinding | null = null;
    for (const item of items) {
      if (item.route !== "write" || !item.binding) continue;
      const w = item.binding.domain.previewWrite(item.cmd, item.binding.session);
      if (w === null) continue; // navigation/run-style commands are not writes
      if (writeBinding && writeBinding !== item.binding) {
        throw new CliError(
          `A single run cannot mix ${writeBinding.domain.label} edits and ` +
            `${item.binding.domain.label} edits (separate undo systems) — split it into two runs`,
          item.cmd.line,
        );
      }
      writeBinding = item.binding;
      writeLabels.push(...w.labels);
      hasWildcard = hasWildcard || w.wildcard;
    }

    return {
      items,
      writeLabels,
      hasWildcard,
      needsConfirm: writeLabels.length > 1 || hasWildcard,
      writeBinding,
      confirmNote:
        writeLabels.length > 1 && writeBinding?.domain.batch
          ? writeBinding.domain.batch.confirmNote
          : null,
    };
  };

  const execItem = async (item: PlannedCommand, io: CliIo): Promise<void> => {
    switch (item.route) {
      case "help":
        io.print(helpText(item.cmd.pos.map((t) => t.text)));
        return;
      case "clear":
        io.clear();
        return;
      case "undo":
        await item.binding!.domain.undoRedo!.undo(item.binding!.session, io);
        return;
      case "redo":
        await item.binding!.domain.undoRedo!.redo(item.binding!.session, io);
        return;
      case "read":
        await item.binding!.domain.runRead(item.cmd, item.binding!.session, io);
        return;
      case "write":
        await item.binding!.domain.runWrite(item.cmd, item.binding!.session, io);
        return;
    }
  };

  const executeRun = async (plan: RunPlan, io: CliIo): Promise<RunOutcome> => {
    const wb = plan.writeBinding;
    const batch = wb?.domain.batch ?? null;
    const useBatch =
      plan.writeLabels.length > 1 && batch !== null && wb !== null && wb.domain.isWritable(wb.session);
    let batchOpen = false;
    let completedWrites = 0;

    if (useBatch && wb && batch) {
      await batch.begin(wb.session);
      batchOpen = true;
    }
    try {
      for (const item of plan.items) {
        await execItem(item, io);
        if (item.route === "write") completedWrites += 1;
      }
      if (batchOpen && wb && batch) {
        batchOpen = false;
        await batch.end(wb.session);
      }
    } catch (e) {
      const msg =
        e instanceof CliError && e.line !== null ? `line ${e.line}: ${errText(e)}` : errText(e);
      if (batchOpen && wb && batch) {
        batchOpen = false;
        try {
          const outcome = await batch.onError(wb.session);
          io.print(`Error — ${msg}`, "err");
          io.print(
            outcome === "rolled-back"
              ? "All changes from this run were rolled back."
              : `The ${completedWrites} completed edit(s) were kept as ONE undo step — run 'undo' to revert them.`,
            "info",
          );
        } catch (recoveryErr) {
          io.print(`Error — ${msg}`, "err");
          io.print(`Rollback also failed: ${errText(recoveryErr)}`, "err");
        }
        return { ok: false, hadWrites: completedWrites > 0 };
      }
      io.print(`Error — ${msg}`, "err");
      return { ok: false, hadWrites: completedWrites > 0 };
    }

    return { ok: true, hadWrites: completedWrites > 0 };
  };

  return { parser, bindings, defaultBinding, planRun, executeRun, helpText };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
