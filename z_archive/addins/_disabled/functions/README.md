# Functions Add-in (DISABLED)

This add-in is currently disabled while the core is being developed.

## What This Will Provide
- Function library browser
- Function categories (Financial, Statistical, Text, Date, etc.)
- Function insertion
- Calculation mode control (Automatic/Manual)

## Original Locations
- FormulasTab.tsx from components/Ribbon/tabs/FormulasTab/
- FunctionLibraryGroup.tsx from components/Ribbon/tabs/FormulasTab/
- CalculationGroup.tsx from components/Ribbon/tabs/FormulasTab/

## To Re-enable
1. Ensure core function registration API is defined
2. Create add-in manifest
3. Move files from _disabled to active location
4. Register with ExtensionRegistry
