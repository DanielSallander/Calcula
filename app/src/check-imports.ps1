# Get the directory where the script is located
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Find all TypeScript files
$tsFiles = Get-ChildItem -Path $scriptDir -Recurse -Include "*.ts", "*.tsx" | Where-Object { 
    $_.FullName -notmatch "node_modules" -and $_.FullName -notmatch "dist" -and $_.FullName -notmatch "build"
}

# Track if any errors were found
$totalErrors = 0

foreach ($file in $tsFiles) {
    $content = Get-Content -Path $file.FullName -Raw -ErrorAction SilentlyContinue
    
    # Skip empty files or files that couldn't be read
    if ([string]::IsNullOrEmpty($content)) {
        continue
    }
    
    $relativePath = $file.FullName.Substring($scriptDir.Length + 1).Replace("\", "/")
    $fileDir = Split-Path -Parent $file.FullName
    
    # Find all import statements
    $importPattern = 'import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?[''"]([^''"]+)[''"]'
    $importMatches = [regex]::Matches($content, $importPattern)
    
    $errorImports = @()
    
    foreach ($match in $importMatches) {
        $importPath = $match.Groups[1].Value
        
        # Skip node_modules imports (packages without ./ or ../)
        if (-not $importPath.StartsWith(".")) {
            continue
        }
        
        # Resolve the import path
        $resolvedPath = Join-Path -Path $fileDir -ChildPath $importPath
        
        # Check various possible extensions and index files
        $possiblePaths = @(
            $resolvedPath,
            "$resolvedPath.ts",
            "$resolvedPath.tsx",
            "$resolvedPath.js",
            "$resolvedPath.jsx",
            "$resolvedPath.json",
            (Join-Path $resolvedPath "index.ts"),
            (Join-Path $resolvedPath "index.tsx"),
            (Join-Path $resolvedPath "index.js"),
            (Join-Path $resolvedPath "index.jsx")
        )
        
        $found = $false
        foreach ($possiblePath in $possiblePaths) {
            if (Test-Path -Path $possiblePath -PathType Leaf) {
                $found = $true
                break
            }
        }
        
        if (-not $found) {
            $errorImports += $importPath
        }
    }
    
    # Output results for this file if there are errors
    if ($errorImports.Count -gt 0) {
        Write-Host "* $relativePath" -ForegroundColor Yellow
        foreach ($errorImport in $errorImports) {
            Write-Host "   * $errorImport" -ForegroundColor Red
            $totalErrors++
        }
    }
}

# Summary
Write-Host ""
Write-Host "----------------------------------------"
if ($totalErrors -eq 0) {
    Write-Host "No import errors found!" -ForegroundColor Green
} else {
    Write-Host "Total import errors found: $totalErrors" -ForegroundColor Red
}