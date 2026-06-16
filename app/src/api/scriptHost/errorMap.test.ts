//! FILENAME: app/src/api/scriptHost/errorMap.test.ts
// PURPOSE: Guard the broker-error -> cell-error mapping, especially that REFUSED
//          code (denied/ungranted capability) surfaces as #BLOCKED! — a distinct
//          "the code was refused" signal, not a stale value or a generic error.

import { describe, it, expect } from "vitest";
import { BrokerError } from "./broker";
import { brokerErrorToCellError } from "./errorMap";

describe("brokerErrorToCellError", () => {
  it("maps refused code (PermissionDenied / CapabilityRequired) to #BLOCKED!", () => {
    expect(brokerErrorToCellError(new BrokerError("PermissionDenied", "denied"))).toBe("#BLOCKED!");
    expect(brokerErrorToCellError(new BrokerError("CapabilityRequired", "not granted"))).toBe("#BLOCKED!");
  });

  it("maps an unknown method to #NAME?", () => {
    expect(brokerErrorToCellError(new BrokerError("UnknownMethod", "gone"))).toBe("#NAME?");
  });

  it("maps genuine failures (bad args / timeout / host error) to #VALUE!", () => {
    expect(brokerErrorToCellError(new BrokerError("ValidationError", "bad args"))).toBe("#VALUE!");
    expect(brokerErrorToCellError(new BrokerError("Timeout", "slow"))).toBe("#VALUE!");
    expect(brokerErrorToCellError(new BrokerError("HostError", "boom"))).toBe("#VALUE!");
  });

  it("maps a non-BrokerError throw to #VALUE!", () => {
    expect(brokerErrorToCellError(new Error("plain"))).toBe("#VALUE!");
    expect(brokerErrorToCellError("string error")).toBe("#VALUE!");
  });
});
