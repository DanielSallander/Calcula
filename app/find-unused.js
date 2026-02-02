//! FILENAME: app/find-unused.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const madge = require('madge');
const path = require('path');

// CONFIGURATION
// ----------------------------------------------------------------
// The folder where your frontend code lives (Tauri usually uses 'src')
const targetDir = 'src';

// List filenames here that are entry points. 
// These are files that are never imported by other JS/TS files 
// (e.g. imported by index.html), so they should not be counted as unused.
const knownEntryPoints = [
  'main.tsx',
  'main.ts',
  'index.tsx',
  'index.ts',
  'App.tsx',
  'routes.tsx',
  'vite-env.d.ts'
];
// ----------------------------------------------------------------

console.log(`Scanning ${targetDir} for unused files...`);

madge(targetDir, {
  baseDir: '.',
  fileExtensions: ['js', 'jsx', 'ts', 'tsx'],
  // Exclude common non-source directories to prevent errors or slowdowns
  excludeRegExp: [
    /node_modules/,
    /^\.git/,
    /^dist/,
    /^build/,
    /^src-tauri/, // Ignore Rust backend files
    /\.test\./,   // Optional: Ignore test files if you wish
    /\.spec\./
  ]
}).then((res) => {
  // Get all files that have no dependents (orphans)
  const orphans = res.orphans();

  // Filter out the known entry points from the list
  const realUnused = orphans.filter((filePath) => {
    const fileName = path.basename(filePath);
    return !knownEntryPoints.includes(fileName);
  });

  // Output results
  if (realUnused.length === 0) {
    console.log('[OK] Great job! No unused files detected.');
  } else {
    console.log('--------------------------------------------------');
    console.log(`Found ${realUnused.length} unused files:`);
    console.log('--------------------------------------------------');
    
    realUnused.forEach((file) => {
      // Use Windows friendly separators if needed, though Node handles this well
      console.log(`[UNUSED] ${file}`);
    });
    
    console.log('--------------------------------------------------');
    console.log('Tip: Double check these files before deleting.');
  }
}).catch((err) => {
  console.error('[ERROR] Analysis failed:');
  console.error(err);
});