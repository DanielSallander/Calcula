# ACCRINT function

## Introduction

The ACCRINT function returns the accrued interest for a security that pays periodic interest. Accrued interest is the interest that has accumulated since the last coupon payment date up to (but not including) the settlement date.

Use ACCRINT when you need to calculate the interest a bond buyer must pay to the seller at settlement, or to determine how much interest has built up on a fixed-income security between coupon dates.

## Syntax

```
=ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| issue | Required | The security's issue date. |
| first_interest | Required | The security's first interest (coupon) date. |
| settlement | Required | The security's settlement date. Must be after the issue date. |
| rate | Required | The security's annual coupon rate. |
| par | Required | The security's par (face) value. If omitted, par is assumed to be $1,000. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |
| calc_method | Optional | A logical value that specifies how to calculate total accrued interest when the settlement date is after the first interest date. TRUE or omitted = return total accrued interest from issue to settlement. FALSE = return accrued interest from first interest date to settlement. |

### Remarks

- Dates should be entered as serial date numbers or references to cells containing dates.
- Rate and par must be positive numbers.
- Frequency must be 1, 2, or 4; any other value returns an error.
- If issue or settlement is not a valid date, ACCRINT returns a #VALUE! error.
- If rate <= 0 or par <= 0, ACCRINT returns a #NUM! error.
- If basis < 0 or basis > 4, ACCRINT returns a #NUM! error.
- If issue >= settlement, ACCRINT returns a #NUM! error.

## Example

### Example 1: Semi-annual bond accrued interest

Calculate the accrued interest on a bond issued on March 1, 2024 with settlement on July 1, 2024.

| | A | B |
|---|---|---|
| 1 | **Bond Accrued Interest** | |
| 2 | Issue date | 3/1/2024 |
| 3 | First interest date | 9/1/2024 |
| 4 | Settlement date | 7/1/2024 |
| 5 | Coupon rate | 6% |
| 6 | Par value | $1,000 |
| 7 | Frequency | 2 |
| 8 | Basis | 0 |
| 9 | | |
| 10 | **Formula** | **Result** |
| 11 | =ACCRINT(B2, B3, B4, B5, B6, B7, B8) | $20.00 |

**Result:** $20.00

The bond has accrued $20.00 in interest from the issue date to the settlement date. The buyer must pay this accrued interest to the seller in addition to the purchase price.
