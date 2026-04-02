# YIELDDISC function

## Introduction

The YIELDDISC function returns the annual yield for a discounted security. Discounted securities are sold below face value and do not pay periodic interest; the return comes entirely from the difference between the purchase price and the redemption value at maturity.

Use YIELDDISC to calculate the yield on Treasury bills, commercial paper, and other money market instruments that trade on a discount basis.

## Syntax

```
=YIELDDISC(settlement, maturity, pr, redemption, [basis])
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
- If basis < 0 or basis > 4, YIELDDISC returns a #NUM! error.

## Example

### Example 1: Treasury bill yield

| | A | B |
|---|---|---|
| 1 | **T-Bill Yield** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 9/15/2024 |
| 4 | Price | $97.50 |
| 5 | Redemption | 100 |
| 6 | Basis | 2 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =YIELDDISC(B2, B3, B4, B5, B6) | 5.13% |

**Result:** 5.13%

The discounted security purchased at $97.50 with a $100 redemption value yields 5.13% annualized. The $2.50 discount over the approximately 6-month holding period translates to this annual yield.
