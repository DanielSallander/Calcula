# ENDSWITH

Returns TRUE if text ends with the given suffix.

## Syntax

```
ENDSWITH(text, suffix)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to examine. |
| `suffix` | The suffix to test for at the end of `text`. |

## Return value

A boolean. TRUE if `text` ends with `suffix`, FALSE otherwise.

## Remarks

- Generates SQL `(RIGHT(text, LENGTH(suffix)) = suffix)` internally.
- The comparison is case-sensitive. "XL" and "xl" are treated as different suffixes.
- Returns FALSE (not an error) when `text` or `suffix` is null.
- For case-insensitive matching, combine with [LOWER](LOWER.md) on both arguments.

## Example 1: Detect size suffix in product names

Check whether a product name ends with "XL".

```
DEFINE IsXL = ENDSWITH(dim_product[name], "XL")
```

## Example 2: Identify product number endings

Flag products whose number ends with a specific revision code.

```
DEFINE IsRevisionR = IF(ENDSWITH(dim_product[productnumber], "-R"), "Revised", "Original")
```

## Example 3: Match category suffix

Find categories that end with "Accessories".

```
DEFINE IsAccessoryCategory = ENDSWITH(dim_product[category], "Accessories")
```

## See also

- [STARTSWITH](STARTSWITH.md) -- test if text begins with a prefix
- [CONTAINS](CONTAINS.md) -- test if text contains a substring (case-insensitive)
- [RIGHT](RIGHT.md) -- extract characters from the end of text
