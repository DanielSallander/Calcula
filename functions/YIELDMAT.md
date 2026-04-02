# YIELDMAT function

## Introduction

The YIELDMAT function returns the annual yield of a security that pays interest at maturity. Unlike regular coupon bonds, these securities accumulate all interest and pay it in a single lump sum at maturity.

Use YIELDMAT to calculate the yield on certificates of deposit, certain agency notes, and other instruments that pay interest only at maturity.

## Syntax

```
=YIELDMAT(settlement, maturity, issue, rate, pr, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| issue | Required | The security's issue date. |
| rate | Required | The security's interest rate at date of issue. |
| pr | Required | The security's price per $100 face value. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Rate must be >= 0. Pr must be > 0.
- If basis < 0 or basis > 4, YIELDMAT returns a #NUM! error.

## Example

### Example 1: Yield on a security paying interest at maturity

| | A | B |
|---|---|---|
| 1 | **Yield at Maturity** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 9/15/2024 |
| 4 | Issue date | 1/15/2024 |
| 5 | Rate | 4.50% |
| 6 | Price | $99.50 |
| 7 | Basis | 0 |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =YIELDMAT(B2, B3, B4, B5, B6, B7) | 5.51% |

**Result:** 5.51%

The security purchased at $99.50 yields 5.51% on an annualized basis. The yield exceeds the stated rate of 4.50% because the security was purchased below par, providing additional return from the price appreciation to maturity.
