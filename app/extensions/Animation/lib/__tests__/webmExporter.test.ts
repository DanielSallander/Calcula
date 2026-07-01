import { describe, it, expect, afterEach, vi } from "vitest";
import { pickWebmMimeType, isWebmRecordingSupported } from "../webmExporter";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickWebmMimeType", () => {
  it("returns '' when MediaRecorder is unavailable (e.g. test runtime)", () => {
    expect(pickWebmMimeType()).toBe("");
  });

  it("picks the first supported candidate", () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (t: string) => t === "video/webm;codecs=vp8",
    });
    expect(pickWebmMimeType()).toBe("video/webm;codecs=vp8");
  });

  it("returns '' when nothing is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickWebmMimeType()).toBe("");
  });
});

describe("isWebmRecordingSupported", () => {
  it("is false without MediaRecorder / a mounted grid canvas", () => {
    expect(isWebmRecordingSupported()).toBe(false);
  });
});
