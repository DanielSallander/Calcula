# SEARCH

Returns the starting position of one text string within another. The search is case-insensitive.

## Syntax

```
SEARCH(find_text, within_text [, start_pos])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `find_text` | The text string to find. |
| `within_text` | The text string to search within. |
| `start_pos` | Optional. The position from which to start searching, 1-based. Defaults to 1. |

## Return value

An integer representing the 1-based position where `find_text` first appears in `within_text` (case-insensitive). Returns 0 if the text is not found.

## Remarks

- Generates a SQL `STRPOS(LOWER(within_text), LOWER(find_text))` expression internally.
- The search is case-insensitive. Use [FIND](FIND.md) for case-sensitive matching.
- Positions are 1-based, consistent with DAX conventions.
- Returns 0 (not an error) when the text is not found, unlike DAX which returns an error.
- The `start_pos` parameter is accepted for DAX compatibility but the SQL implementation always searches from the beginning of the string.

## Example 1: Case-insensitive substring search

Find the position of "mountain" regardless of case.

```
DEFINE MountainPos = SEARCH("mountain", dim_product[name])
```

## Example 2: Check if text contains a keyword

Use SEARCH with IF for a case-insensitive contains check.

```
DEFINE IsBike = IF(SEARCH("bike", dim_product[productcategory]) > 0, "Yes", "No")
```

## See also

- [FIND](FIND.md) -- case-sensitive version of SEARCH
- [MID](MID.md) -- extract a substring by position
- [LOWER](LOWER.md) -- convert text to lowercase
- [SUBSTITUTE](SUBSTITUTE.md) -- replace occurrences of text within a string
- [LEN](LEN.md) -- return the length of a text string
