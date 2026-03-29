# ISOWEEKNUM function

## Introduction
The ISOWEEKNUM function returns the ISO 8601 week number of a given date. ISO weeks start on Monday, and the first week of the year is the one that contains the first Thursday of January. This is the international standard for week numbering.

## Syntax
```
=ISOWEEKNUM(date)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| date | Required | The date for which to find the ISO week number. |

## Remarks
- ISO week numbers range from 1 to 52 or 53.
- A date in late December may belong to ISO week 1 of the following year.
- A date in early January may belong to ISO week 52 or 53 of the previous year.
- Unlike WEEKNUM, ISOWEEKNUM always uses Monday as the start of the week.

## Example

| | A | B |
|---|---|---|
| 1 | **Date** | **ISO Week** |
| 2 | 2024-01-01 | =ISOWEEKNUM(A2) |

**Result:** 1
