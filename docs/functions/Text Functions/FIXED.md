# FIXED

Rounds a number to the specified number of decimal places and returns the result as text.

## Syntax

```
FIXED(number [, decimals [, no_commas]])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `number` | The number to round and convert to text. |
| `decimals` | Optional. The number of decimal places. Defaults to 2. |
| `no_commas` | Optional. A boolean. Accepted for DAX compatibility but ignored -- the SQL implementation does not add thousands separators. |

## Return value

A text string representing the rounded number.

## Remarks

- Generates a SQL `CAST(ROUND(number, decimals) AS VARCHAR)` expression internally.
- The `no_commas` parameter is accepted for compatibility with DAX but has no effect, since the underlying SQL `CAST` does not produce thousands separators.
- If `decimals` is negative, the number is rounded to the left of the decimal point (e.g., `FIXED(1234, -2)` returns `"1200"`).
- The result is always a text string, not a number. Use [VALUE](VALUE.md) to convert back to a number if needed.

## Example 1: Format revenue as text with 2 decimals

```
DEFINE RevenueText = FIXED(SUM(fact_sales[linetotal]), 2)
```

## Example 2: Round to whole number as text

```
DEFINE WholeNumber = FIXED(SUM(fact_sales[linetotal]), 0)
```

## Example 3: Round to nearest hundred

```
DEFINE RoundedHundreds = FIXED(SUM(fact_sales[linetotal]), -2)
```

## See also

- [ROUND](ROUND.md) -- round a number (returns a number, not text)
- [VALUE](VALUE.md) -- convert text to a number
- [CONCATENATE](CONCATENATE.md) -- join text strings
- [INT](INT.md) -- truncate to integer
