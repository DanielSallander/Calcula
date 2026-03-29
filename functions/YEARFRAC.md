# YEARFRAC function

## Introduction
The YEARFRAC function returns the fraction of the year represented by the number of whole days between two dates. It is commonly used in financial calculations such as bond pricing, accrued interest, and pro-rata adjustments.

## Syntax
```
=YEARFRAC(start_date, end_date, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The start date. |
| end_date | Required | The end date. |
| basis | Optional | The day count basis. 0 = US 30/360 (default), 1 = actual/actual, 2 = actual/360, 3 = actual/365, 4 = European 30/360. |

## Remarks
- The basis argument determines how days in a month and year are counted.
- If start_date is greater than end_date, the result is still positive.
- Returns #VALUE! if dates are not valid or basis is outside 0-4.

## Example

| | A | B |
|---|---|---|
| 1 | **Start** | **End** |
| 2 | 2024-01-01 | 2024-07-01 |
| 3 | **Fraction** | =YEARFRAC(A2, B2, 1) |

**Result:** Approximately 0.4973 (actual/actual basis)
