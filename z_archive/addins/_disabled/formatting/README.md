# Formatting Add-in (DISABLED)

This add-in is currently disabled while the core is being developed.

## What This Will Provide
- Font formatting (bold, italic, font size, font family, text color)
- Cell formatting (background color, borders)
- Alignment (horizontal, vertical, wrap text, rotation)
- Number formatting (currency, percentage, dates, custom formats)

## Original Locations
- FontGroup.tsx from components/Ribbon/tabs/HomeTab/
- AlignmentGroup.tsx from components/Ribbon/tabs/HomeTab/
- NumberGroup.tsx from components/Ribbon/tabs/HomeTab/
- ColorPicker.tsx from components/Ribbon/pickers/
- NumberFormatPicker.tsx from components/Ribbon/pickers/

## To Re-enable
1. Ensure core styling API is defined in ExtensionRegistry
2. Create add-in manifest
3. Move files from _disabled to active location
4. Register with ExtensionRegistry
