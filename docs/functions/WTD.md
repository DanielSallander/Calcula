# WTD

Week-to-date: evaluates a measure from the Monday of the current context's ISO week through the as-of date.

## Syntax

```
WTD(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The aggregate to accumulate week-to-date. |

## Return value

The inner aggregate over `[Monday of the as-of date's ISO week, as-of date]`, where the as-of date is the latest date present in the current filter context.

## Remarks

- Weeks are ISO weeks: they start on Monday.
- Filter-context only in v1: a date-table column on the query axis fails closed (the axis running-window form exists for YTD/QTD/MTD but not yet for weeks). Slice to a day or range and WTD accumulates within that week.
- Requires a marked date table with a `DateKey` role column.
- Generated `CALENDAR(...)` tables carry a `week` column (ISO week number) you can slice or group by.
- The fiscal-year setting does not affect WTD (weeks have no fiscal offset).

## Example

```
DEFINE Sales WTD = WTD(SUM(fact_sales[linetotal]))
```

With a slicer on `2024-03-14` (a Thursday), sums sales from Monday `2024-03-11` through the 14th.

## See also

- [YTD](YTD.md)
- [DATESINPERIOD](DATESINPERIOD.md)
