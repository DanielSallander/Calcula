# PRICEMAT function

## Introduction

The PRICEMAT function returns the price per $100 face value of a security that pays interest at maturity. Unlike regular coupon bonds that pay interest periodically, these securities accumulate all interest and pay it as a lump sum at the maturity date.

Use PRICEMAT to price certificates of deposit, certain agency notes, and other fixed-income instruments that pay interest only at maturity.

## Syntax

```
=PRICEMAT(settlement, maturity, issue, rate, yld, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| issue | Required | The security's issue date. |
| rate | Required | The security's interest rate at date of issue. |
| yld | Required | The security's annual yield. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Rate and yld must be >= 0.
- If basis < 0 or basis > 4, PRICEMAT returns a #NUM! error.

## Example

### Example 1: Security paying interest at maturity

| | A | B |
|---|---|---|
| 1 | **Price at Maturity** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 9/15/2024 |
| 4 | Issue date | 1/15/2024 |
| 5 | Interest rate | 4.50% |
| 6 | Yield | 5.00% |
| 7 | Basis | 0 |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =PRICEMAT(B2, B3, B4, B5, B6, B7) | $99.77 |

**Result:** $99.77

The security trades slightly below par because the yield (5.00%) exceeds the coupon rate (4.50%). The price reflects the present value of the maturity payment discounted at the required yield.
