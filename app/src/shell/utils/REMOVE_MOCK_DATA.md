# How to Remove Mock Data Feature

This feature was added for development and testing purposes only. When you're done testing and want to remove it completely, follow these steps:

## Files to Delete

1. **Delete these files:**
   - `app/src/shell/utils/mockData.ts`
   - `app/src/shell/utils/mockData.csv.ts`
   - `app/src/shell/utils/REMOVE_MOCK_DATA.md` (this file)

## Code to Remove

2. **In `app/src/shell/Layout.tsx`:**

   Remove the import statement:
   ```typescript
   // DEV ONLY: Mock data loader for testing - remove these imports when done testing
   import { loadMockData, shouldLoadMockData } from "./utils/mockData";
   ```

   Remove the useEffect hook (around line 122-133):
   ```typescript
   // DEV ONLY: Load mock data on mount if environment variable is set
   // DELETE THIS BLOCK when done testing
   useEffect(() => {
     if (shouldLoadMockData()) {
       // Small delay to ensure grid is fully initialized
       const timer = setTimeout(() => {
         loadMockData().catch((error) => {
           console.error("[Layout] Failed to load mock data:", error);
         });
       }, 500);
       return () => clearTimeout(timer);
     }
   }, []);
   ```

## Scripts to Remove (Optional)

3. **In `app/package.json`:**

   Optionally remove these scripts if you don't need them:
   ```json
   "dev:data": "cross-env VITE_LOAD_MOCK_DATA=true vite",
   "tauri:dev:data": "cross-env VITE_LOAD_MOCK_DATA=true tauri dev"
   ```

   You can also uninstall `cross-env` if not used elsewhere:
   ```bash
   yarn remove cross-env
   ```

## That's It!

After these changes, the mock data feature will be completely removed and won't affect your application.
