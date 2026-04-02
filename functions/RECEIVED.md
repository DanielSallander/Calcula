# RECEIVED function

## Introduction

The RECEIVED function returns the amount received at maturity for a fully invested security. It calculates the total payout at maturity based on the investment amount, discount rate, and holding period.

Use RECEIVED to determine the maturity value of a discount security when you know the purchase price and the discount rate.

## Syntax

```
=RECEIVED(settlement, maturity, investment, discount, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| investment | Required | The amount invested in the security. |
| discount | Required | The security's discount rate. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Investment and discount must be > 0.
- If basis < 0 or basis > 4, RECEIVED returns a #NUM! error.

## Example

### Example 1: Maturity value of a discount security

| | A | B |
|---|---|---|
| 1 | **Amount Received** | |
| 2 | Settlement date | 3/1/2024 |
| 3 | Maturity date | 9/1/2024 |
| 4 | Investment | $1,000,000 |
| 5 | Discount rate | 5.25% |
| 6 | Basis | 0 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =RECEIVED(B2, B3, B4, B5, B6) | $1,027,009.35 |

**Result:** $1,027,009.35

An investment of $1,000,000 in a security with a 5.25% discount rate held for approximately 6 months will return $1,027,009.35 at maturity.
