# Launch Calcula with WebView2 remote debugging enabled.
# This allows Playwright (or Chrome DevTools) to connect via CDP.
#
# Usage:
#   .\e2e\launch-with-cdp.ps1            # default port 9222
#   .\e2e\launch-with-cdp.ps1 -Port 9333 # custom port
#
# Then in another terminal:
#   yarn e2e:manual

param(
    [int]$Port = 9222
)

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

Write-Host ""
Write-Host "  Calcula E2E - launching with CDP on port $Port" -ForegroundColor Cyan
Write-Host "  Connect Playwright:  yarn e2e:manual" -ForegroundColor DarkGray
Write-Host "  Connect DevTools:    http://127.0.0.1:$Port" -ForegroundColor DarkGray
Write-Host ""

# Run from the app directory
Set-Location $PSScriptRoot\..
yarn tauri dev
