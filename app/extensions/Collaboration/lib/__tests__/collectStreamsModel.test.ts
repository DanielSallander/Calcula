//! FILENAME: app/extensions/Collaboration/lib/__tests__/collectStreamsModel.test.ts
// PURPOSE: The pure rules of Writeback > Collect From: what a click asks for,
//          which row may not be unticked, the hero's badge and tooltip.

import { describe, it, expect } from "vitest";
import type { CollectionStreamsView, StreamChoice } from "@api/collaboration";
import {
  nextChoice,
  isLastIncluded,
  heroBadge,
  heroTooltip,
  notCollectedText,
  defaultRowLabel,
  choiceTestId,
  NOT_PUBLISHED_TOOLTIP,
} from "../collectStreamsModel";

function choice(stream: string, included: boolean, kind: StreamChoice["kind"] = "environment"): StreamChoice {
  return {
    stream,
    label: stream === "" ? "Development line" : stream,
    kind: stream === "" ? "developmentLine" : kind,
    included,
    version: null,
    hint: "",
  };
}

function view(over: Partial<CollectionStreamsView> = {}): CollectionStreamsView {
  return {
    linked: true,
    packageName: "app",
    registryUrl: "C:\\ws",
    mode: "default",
    selection: null,
    collecting: ["prod"],
    defaultStream: "prod",
    choices: [choice("", false), choice("test", false), choice("prod", true)],
    notCollected: [],
    environmentsError: null,
    summary: "prod (the last environment)",
    canChange: true,
    changeRefusal: null,
    ...over,
  };
}

const ALL = view({
  mode: "all",
  collecting: null,
  summary: "All streams",
  choices: [choice("", true), choice("test", true), choice("prod", true), choice("old", true, "removed")],
});

describe("what a click on a stream row asks for", () => {
  it("from the DEFAULT, ticking test adds it to the last environment", () => {
    expect(nextChoice(view(), "test")).toEqual({ only: ["prod", "test"] });
  });

  it("from ALL streams, unticking prod keeps every OTHER listed stream -- removed tags included", () => {
    expect(nextChoice(ALL, "prod")).toEqual({ only: ["", "old", "test"] });
  });

  it("an explicit set toggles the clicked stream in and out", () => {
    const only = view({ mode: "only", selection: ["", "prod"], choices: [choice("", true), choice("test", false), choice("prod", true)] });
    expect(nextChoice(only, "test")).toEqual({ only: ["", "prod", "test"] });
    expect(nextChoice(only, "")).toEqual({ only: ["prod"] });
  });

  // SABOTAGE: return `{ only: [] }` instead of "refuse".
  it("unticking the LAST collected stream is refused, and that row is disabled", () => {
    expect(nextChoice(view(), "prod")).toBe("refuse");
    const prod = view().choices[2];
    expect(isLastIncluded(view(), prod)).toBe(true);
    expect(isLastIncluded(view(), view().choices[1])).toBe(false);
    expect(isLastIncluded(ALL, ALL.choices[2])).toBe(false);
  });
});

describe("the hero says what is collected", () => {
  it("badge: nothing for the default and All, the count for a set, ! when something is left out", () => {
    expect(heroBadge(view())).toBeUndefined();
    expect(heroBadge(ALL)).toBeUndefined();
    expect(heroBadge(view({ mode: "only", selection: ["", "prod"] }))).toBe(2);
    expect(heroBadge(view({ mode: "only", selection: ["prod"], notCollected: ["staging"] }))).toBe("!");
    expect(heroBadge(null)).toBeUndefined();
  });

  it("tooltip: the choice, what is left out, who uses it, and why it is locked", () => {
    expect(heroTooltip(view())).toContain("Collecting from: prod (the last environment).");
    expect(heroTooltip(view())).toContain("model tables");
    const left = heroTooltip(view({ mode: "only", selection: ["prod"], notCollected: ["staging"], summary: "prod" }));
    expect(left).toContain("Not collected: staging.");
    const locked = heroTooltip(view({ canChange: false, changeRefusal: "Only the publisher of 'app' can ..." }));
    expect(locked).toContain("Only the publisher of 'app'");
    expect(heroTooltip(null)).toBe(NOT_PUBLISHED_TOOLTIP);
    expect(heroTooltip(view({ linked: false }))).toBe(NOT_PUBLISHED_TOOLTIP);
  });

  it("the pane's warning names what an explicit choice leaves out", () => {
    expect(notCollectedText(view())).toBeNull();
    expect(notCollectedText(view({ notCollected: ["staging"] }))).toBe(
      "Not collected: staging. Tick it in Writeback > Collect From to include its answers.",
    );
    expect(notCollectedText(view({ notCollected: ["a", "b"] }))).toContain("Tick them");
  });

  it("offers the default back only when another choice is held", () => {
    expect(defaultRowLabel(view())).toBeNull();
    expect(defaultRowLabel(ALL)).toBe("Default: the last environment (prod)");
    expect(defaultRowLabel(view({ mode: "all", defaultStream: null }))).toBeNull();
  });

  it("rows have stable test ids", () => {
    expect(choiceTestId("")).toBe("writeback-collect-stream-development-line");
    expect(choiceTestId("prod")).toBe("writeback-collect-stream-prod");
  });
});
