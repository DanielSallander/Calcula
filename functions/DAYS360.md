# DAYS360 function

## Introduction
The DAYS360 function calculates the number of days between two dates based on a 360-day year (twelve 30-day months). This is commonly used in financial accounting and interest calculations where a standardized month length simplifies computations.

## Syntax
```
=DAYS360(start_date, end_date, [method])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The start date. |
| end_date | Required | The end date. |
| method | Optional | FALSE or omitted = U.S. (NASD) method, TRUE = European method. |

## Remarks
- U.S. method: If start date is the 31st, it becomes the 30th. If end date is the 31st and start date is on or after the 30th, end date becomes the 30th.
- European method: Both start and end dates that fall on the 31st are changed to the 30th.
- Dates should be entered as cell references or date functions to avoid interpretation errors.

## Example

| | A | B |
|---|---|---|
| 1 | **Start** | **End** |
| 2 | 2024-01-30 | 2024-07-31 |
| 3 | **Days** | =DAYS360(A2, B2) |

**Result:** 180
