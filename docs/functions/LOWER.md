# LOWER

Converts all characters in a text string to lowercase.

## Syntax

```
LOWER(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to convert to lowercase. |

## Return value

A text string with all characters converted to lowercase.

## Remarks

- Generates a SQL `LOWER(text)` expression internally.
- Non-alphabetic characters are unchanged.
- If `text` is NULL, the result is NULL.
- Use LOWER on both sides of a comparison for case-insensitive matching as an alternative to [SEARCH](SEARCH.md).

## Example 1: Normalize product color to lowercase

```
DEFINE ColorLower = LOWER(dim_product[color])
```

## Example 2: Case-insensitive comparison

Compare two strings without regard to case.

```
DEFINE SameColorCI = IF(LOWER(dim_product[color]) = LOWER("RED"), "Match", "No Match")
```

## See also

- [UPPER](UPPER.md) -- convert text to uppercase
- [EXACT](EXACT.md) -- case-sensitive text comparison
- [SEARCH](SEARCH.md) -- case-insensitive text search
- [TRIM](TRIM.md) -- remove leading and trailing spaces
