# SUBSTITUTE

Replaces occurrences of a text string within another text string with new text.

## Syntax

```
SUBSTITUTE(text, old_text, new_text [, instance_num])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The original text string, or a column reference. |
| `old_text` | The text to find and replace. |
| `new_text` | The replacement text. |
| `instance_num` | Optional. Accepted for DAX compatibility but ignored -- all occurrences are replaced (SQL REPLACE semantics). |

## Return value

A text string with all occurrences of `old_text` replaced by `new_text`.

## Remarks

- Generates a SQL `REPLACE(text, old_text, new_text)` expression internally.
- All occurrences of `old_text` are replaced. The `instance_num` parameter is accepted for DAX compatibility but has no effect.
- The replacement is case-sensitive.
- If `old_text` is not found in `text`, the original string is returned unchanged.
- If `text` is NULL, the result is NULL.
- For positional replacement (by character position rather than pattern), use [REPLACE](REPLACE.md) instead.

## Example 1: Remove hyphens from a product number

```
DEFINE CleanNumber = SUBSTITUTE(dim_product[productnumber], "-", "")
```

## Example 2: Replace a word

Change "Road" to "Street" in product names.

```
DEFINE UpdatedName = SUBSTITUTE(dim_product[name], "Road", "Street")
```

## Example 3: Replace multiple characters by nesting

Remove both hyphens and spaces from a code.

```
DEFINE CompactCode = SUBSTITUTE(SUBSTITUTE(dim_product[productnumber], "-", ""), " ", "")
```

## See also

- [REPLACE](REPLACE.md) -- replace characters by position, not pattern
- [FIND](FIND.md) -- find the position of text within another string
- [CONCATENATE](CONCATENATE.md) -- join text strings
- [TRIM](TRIM.md) -- remove leading and trailing spaces
