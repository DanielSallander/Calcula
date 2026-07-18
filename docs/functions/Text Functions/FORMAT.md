# FORMAT

Formats a value as text using a format pattern. Typically used to format dates into string representations for grouping or display.

## Syntax

```
FORMAT(value, format_string)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `value` | The value to format. Typically a date or timestamp column reference. |
| `format_string` | A string literal (in double quotes) specifying the output format pattern. |

### Common format patterns

| Pattern | Description | Example output |
|---------|-------------|----------------|
| `"YYYY-MM"` | Year and month | `2024-03` |
| `"YYYY"` | Four-digit year | `2024` |
| `"MM"` | Two-digit month | `03` |
| `"DD"` | Two-digit day | `15` |
| `"YYYY-MM-DD"` | Full ISO date | `2024-03-15` |
| `"YYYY-Q"` | Year and quarter number | `2024-1` |

## Return value

A text string representing the formatted value.

## Remarks

- FORMAT always returns a string, so the result is treated as a text column for grouping purposes.
- Generates SQL `TO_CHAR(value, format)` for PostgreSQL. SQL Server uses `FORMAT(value, pattern)`.
- FORMAT is primarily used in calculated columns or group-by expressions to create custom date groupings.
- Because FORMAT returns text, sort order is lexicographic. Use `"YYYY-MM"` patterns (not `"MM-YYYY"`) to ensure correct chronological sorting.

## Example 1: Year-month grouping

Group sales by year and month.

```
DEFINE YearMonth = FORMAT(dim_date[order_date], "YYYY-MM")
```

## Example 2: Quarter label

Create a quarter label from a date.

```
DEFINE QuarterLabel = FORMAT(dim_date[order_date], "YYYY-Q")
```

## See also

- [YEAR](../Date%20and%20Time%20Functions/YEAR.md) — extract year as a number
- [MONTH](../Date%20and%20Time%20Functions/MONTH.md) — extract month as a number
- [QUARTER](../Date%20and%20Time%20Functions/QUARTER.md) — extract quarter as a number
- [CONCATENATE](CONCATENATE.md) — join text values
