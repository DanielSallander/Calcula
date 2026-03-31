# DAYS function

## Introduction

The DAYS function returns the number of days between two dates. The result is positive if end_date is after start_date, and negative if end_date is before start_date.

## Syntax

```
=DAYS(end_date, start_date)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| end_date | Required | The end date (as a serial number or date value). |
| start_date | Required | The start date (as a serial number or date value). |

## Remarks

- The order of arguments is end_date first, then start_date (end - start).
- This is different from DAYS360, which calculates based on a 360-day year.
- Both arguments must be valid date serial numbers.

## Example

| | A | B |
|---|---|---|
| 1 | **Start** | **End** |
| 2 | 44927 | 44957 |

**Formula:** `=DAYS(B2, A2)`

**Result:** **30** - There are 30 days between the two dates.
