# DISC function

## Introduction

The DISC function returns the discount rate for a security. The discount rate represents the percentage reduction from face value at which a security is sold. It is commonly used for money market instruments such as Treasury bills and commercial paper.

Use DISC to determine the discount rate of a security when you know its price, redemption value, and dates.

## Syntax

```
=DISC(settlement, maturity, pr, redemption, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| pr | Required | The security's price per $100 face value. |
| redemption | Required | The security's redemption value per $100 face value. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Pr and redemption must be > 0.
- If basis < 0 or basis > 4, DISC returns a #NUM! error.

## Example

### Example 1: Discount rate of a Treasury bill

| | A | B |
|---|---|---|
| 1 | **Discount Rate** | |
| 2 | Settlement date | 2/15/2024 |
| 3 | Maturity date | 8/15/2024 |
| 4 | Price | $97.50 |
| 5 | Redemption | 100 |
| 6 | Basis | 2 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =DISC(B2, B3, B4, B5, B6) | 4.97% |

**Result:** 4.97%

The security has a discount rate of 4.97%. This means the security was sold at a 4.97% annualized discount from its face value, reflecting the difference between the $97.50 purchase price and $100 redemption value over the holding period.
