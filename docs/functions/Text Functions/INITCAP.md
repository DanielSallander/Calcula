# INITCAP

Capitalizes the first letter of each word in the text string.

## Syntax

```
INITCAP(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to capitalize. |

## Return value

A text string with the first letter of each word converted to uppercase and the remaining letters converted to lowercase.

## Remarks

- Generates SQL `INITCAP(text)` internally.
- Word boundaries are determined by non-alphanumeric characters (spaces, hyphens, etc.).
- Returns null when `text` is null.
- Each word is treated independently: "hello world" becomes "Hello World", "jean-paul" becomes "Jean-Paul".

## Example 1: Title-case product names

Convert product names to title case for display.

```
DEFINE DisplayName = INITCAP(dim_product[name])
```

## Example 2: Normalize color names

Ensure consistent capitalization of color values.

```
DEFINE FormattedColor = INITCAP(dim_product[color])
```

## Example 3: Format category labels

Title-case category names that may have inconsistent casing.

```
DEFINE CategoryLabel = INITCAP(dim_product[category])
```

## See also

- [UPPER](UPPER.md) -- convert text to all uppercase
- [LOWER](LOWER.md) -- convert text to all lowercase
- [TRIM](TRIM.md) -- remove leading and trailing whitespace
