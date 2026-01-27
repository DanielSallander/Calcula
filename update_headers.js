const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * CONFIGURATION
 * Add any extensions you want to strictly include, or leave empty to process all text files.
 * Safety measure to prevent corrupting images/binaries.
 */
const TARGET_EXTENSIONS = [
    '.rs', '.ts', '.tsx', '.js', '.jsx'
];

// Configuration for the header format
const HEADER_PREFIX = '//! FILENAME: ';

function getFiles() {
    try {
        // We use git ls-files to respect .gitignore automatically.
        // --cached: tracked files
        // --others: untracked files (new files)
        // --exclude-standard: apply .gitignore rules
        console.log('Retrieving file list using git...');
        const output = execSync('git ls-files --cached --others --exclude-standard', {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large repos
        });
        
        // Split by new line and filter empty strings
        return output.split(/\r?\n/).filter(line => line.trim().length > 0);
    } catch (error) {
        console.error('Error: Unable to list files. Ensure this is a git repository.');
        console.error(error.message);
        process.exit(1);
    }
}

function isBinary(filePath) {
    // 1. Check extension first for speed
    const ext = path.extname(filePath).toLowerCase();
    if (TARGET_EXTENSIONS.length > 0 && !TARGET_EXTENSIONS.includes(ext)) {
        return true; // Treat as "binary/ignored" if not in our target list
    }

    // 2. Double check content for null bytes (safeguard)
    try {
        const buffer = fs.readFileSync(filePath);
        // Check first 1000 bytes for null character
        const checkBuffer = buffer.subarray(0, Math.min(1000, buffer.length));
        if (checkBuffer.includes(0)) {
            return true;
        }
        return false;
    } catch (e) {
        return true; // If we can't read it, skip it
    }
}

function processFiles() {
    const files = getFiles();
    const rootDir = process.cwd();
    let processedCount = 0;
    let skippedCount = 0;

    console.log(`Found ${files.length} files. Starting processing...`);
    console.log('------------------------------------------------');

    files.forEach((fileRelPath) => {
        // Ensure we are working with the correct OS path separators for file access
        const absolutePath = path.resolve(rootDir, fileRelPath);

        // Don't process this script itself
        if (absolutePath === __filename) return;

        // Skip binary files or non-target extensions
        if (isBinary(absolutePath)) {
            skippedCount++;
            return;
        }

        try {
            const content = fs.readFileSync(absolutePath, 'utf-8');
            const lines = content.split(/\r?\n/);
            
            // Normalize path for the header (force forward slashes for consistency)
            // Even on Windows 11, path.relative might give backslashes.
            // We replace `\` with `/` to match your existing pattern.
            const displayPath = fileRelPath.split(path.sep).join('/');
            
            const expectedHeader = `${HEADER_PREFIX}${displayPath}`;
            
            let newLines = [...lines];
            let modified = false;

            if (newLines.length > 0) {
                const firstLine = newLines[0];

                // CHECK: Does first line contain "FILENAME"?
                if (firstLine.includes('FILENAME')) {
                    // Update existing header if it is different
                    if (firstLine.trim() !== expectedHeader) {
                        newLines[0] = expectedHeader;
                        modified = true;
                    }
                } else {
                    // Insert new header at the top
                    newLines.unshift(expectedHeader);
                    modified = true;
                }
            } else {
                // Empty file
                newLines.push(expectedHeader);
                modified = true;
            }

            if (modified) {
                // Join lines back together. 
                // We use the OS default EOL or just \n. 
                // To be safe and preserve original format often detected by split, 
                // we'll default to \n, but windows might prefer \r\n.
                // Here we use \n for Typescript/Rust standards.
                const newContent = newLines.join('\n');
                fs.writeFileSync(absolutePath, newContent, 'utf-8');
                console.log(`[UPDATED] ${displayPath}`);
                processedCount++;
            }

        } catch (err) {
            console.error(`[ERROR] Could not process ${fileRelPath}: ${err.message}`);
        }
    });

    console.log('------------------------------------------------');
    console.log(`Finished.`);
    console.log(`Updated files: ${processedCount}`);
    console.log(`Skipped (binary/other): ${skippedCount}`);
}

processFiles();