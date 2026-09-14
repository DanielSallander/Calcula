//! FILENAME: app/extensions/_shared/lib/fakeCompletionProvider.ts
// PURPOSE: One TYPED double for `AiCompletionProvider`, for every test that
//          needs a model that answers without one.
// CONTEXT: Written because the hand-rolled doubles drifted, and the drift was
//          INVISIBLE. `tsconfig.check.json` excludes `**/__tests__/**` and every
//          `*.test.ts`, and vitest transpiles without type-checking — so a
//          double annotated `: AiCompletionProvider` that is missing half the
//          interface compiles nowhere and fails nothing, right up until the code
//          under test calls the missing member and the failure arrives as
//          `undefined is not a function` in a test that looks unrelated.
//
//          That is the same blind spot that let a Sort test assert on icon-set
//          names the wire cannot carry. The fix is the same shape: put the thing
//          tsc SHOULD be checking somewhere tsc actually reads. This module is
//          production-path code under `extensions/_shared`, so `check-types`
//          compiles it — and the moment `AiCompletionProvider` grows a member,
//          exactly this file fails to build, rather than five test files failing
//          at runtime weeks apart.
//
//          Every field is overridable because a double that cannot be steered
//          gets copy-pasted instead of reused, which is how the drift started.

import type {
  AiCompletionProvider,
  AiCompletionRequest,
  AiCompletionResult,
  AiModelOption,
} from "@api";

export interface FakeProviderOptions {
  /** Replies handed out in order; the last is repeated once exhausted. */
  replies?: string[];
  configured?: boolean;
  modelLabel?: string;
  isLocal?: boolean;
  honorsSchema?: boolean | undefined;
  honorsGrammar?: boolean | undefined;
  models?: AiModelOption[];
  selectedKey?: string;
  truncated?: boolean;
  /** Throw instead of answering, to exercise a caller's failure path. */
  fail?: string;
  onComplete?: (req: AiCompletionRequest) => void;
  onSelectModel?: (key: string) => void;
  onOpenPicker?: () => void;
}

/** What the double recorded, for assertions. */
export interface FakeProviderSpy {
  requests: AiCompletionRequest[];
  selected: string[];
  pickerOpened: number;
}

export function makeFakeCompletionProvider(
  options: FakeProviderOptions = {},
): AiCompletionProvider & { spy: FakeProviderSpy } {
  const spy: FakeProviderSpy = { requests: [], selected: [], pickerOpened: 0 };
  const replies = options.replies ?? [""];
  let next = 0;
  let selectedKey = options.selectedKey ?? "";

  return {
    spy,
    isConfigured: () => options.configured ?? true,
    modelLabel: () => options.modelLabel ?? "fake-model",
    isLocal: () => options.isLocal ?? true,
    honorsSchema: () => options.honorsSchema,
    honorsGrammar: () => options.honorsGrammar,
    listModels: async () => options.models ?? [],
    selectedModelKey: () => selectedKey,
    selectModel: (key: string) => {
      selectedKey = key;
      spy.selected.push(key);
      options.onSelectModel?.(key);
    },
    openModelPicker: () => {
      spy.pickerOpened += 1;
      options.onOpenPicker?.();
    },
    async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
      spy.requests.push(req);
      options.onComplete?.(req);
      if (options.fail) throw new Error(options.fail);
      const text = replies[Math.min(next, replies.length - 1)] ?? "";
      next += 1;
      return {
        text,
        truncated: options.truncated ?? false,
        model: options.modelLabel ?? "fake-model",
        durationMs: 1,
      };
    },
  };
}

/** One `AiModelOption`, for a picker test that needs a list. */
export function makeFakeModelOption(over: Partial<AiModelOption> = {}): AiModelOption {
  return {
    key: over.key ?? "prov\tmodel\t",
    model: over.model ?? "model",
    providerLabel: over.providerLabel ?? "Provider",
    isLocal: over.isLocal ?? true,
    honorsGrammar: over.honorsGrammar,
  };
}
