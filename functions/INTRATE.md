# INTRATE function

## Introduction

The INTRATE function returns the interest rate for a fully invested security. Unlike DISC which returns the discount rate, INTRATE returns the equivalent interest rate based on the purchase price rather than the face value.

Use INTRATE to calculate the effective interest rate on a discount security, Treasury bill, or other fully invested instrument.

## Syntax

```
=INTRATE(settlement, maturity, investment, redemption, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| investment | Required | The amount invested in the security. |
| redemption | Required | The amount to be received at maturity. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Investment and redemption must be > 0.
- If basis < 0 or basis > 4, INTRATE returns a #NUM! error.

## Example

### Example 1: Interest rate on a fully invested security

| | A | B |
|---|---|---|
| 1 | **Interest Rate** | |
| 2 | Settlement date | 3/1/2024 |
| 3 | Maturity date | 9/1/2024 |
| 4 | Investment | $97.50 |
| 5 | Redemption | $100.00 |
| 6 | Basis | 2 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =INTRATE(B2, B3, B4, B5, B6) | 5.10% |

**Result:** 5.10%

The security provides an annualized interest rate of 5.10% based on the initial investment of $97.50 and the $100 redemption at maturity. Note that INTRATE returns a slightly higher rate than DISC for the same security because it calculates the return based on the purchase price (lower denominator) rather than face value.
