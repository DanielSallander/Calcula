# UPPER

Converts all characters in a text string to uppercase.

## Syntax

```
UPPER(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to convert to uppercase. |

## Return value

A text string with all characters converted to uppercase.

## Remarks

- Generates a SQL `UPPER(text)` expression internally.
- Non-alphabetic characters are unchanged.
- If `text` is NULL, the result is NULL.
- Use UPPER on both sides of a comparison for case-insensitive matching as an alternative to [SEARCH](SEARCH.md).

## Example 1: Normalize product color to uppercase

```
DEFINE ColorUpper = UPPER(dim_product[color])
```

## Example 2: Case-insensitive comparison

Compare two strings without regard to case.

```
DEFINE IsRed = IF(UPPER(dim_product[color]) = "RED", "Yes", "No")
```

## See also

- [LOWER](LOWER.md) -- convert text to lowercase
- [EXACT](EXACT.md) -- case-sensitive text comparison
- [SEARCH](SEARCH.md) -- case-insensitive text search
- [TRIM](TRIM.md) -- remove leading and trailing spaces
