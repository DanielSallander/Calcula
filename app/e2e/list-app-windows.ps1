# List all top-level windows owned by the Calcula app process (app.exe).
# Emits one JSON object per line: {pid, hwnd, class, title, visible}
# Used by the close-prompt E2E to detect the NATIVE unsaved-changes dialog.
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$procIds = @(Get-Process -Name "app" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($procIds.Count -eq 0) { exit 0 }

$results = New-Object System.Collections.ArrayList

$cb = [WinEnum+EnumProc]{
  param($hWnd, $lParam)
  $pid2 = 0
  [WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$pid2) | Out-Null
  if ($procIds -contains [int]$pid2) {
    $cls = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetClassName($hWnd, $cls, 256) | Out-Null
    $txt = New-Object System.Text.StringBuilder 512
    [WinEnum]::GetWindowText($hWnd, $txt, 512) | Out-Null
    $vis = [WinEnum]::IsWindowVisible($hWnd)
    $null = $results.Add([pscustomobject]@{
      pid     = [int]$pid2
      hwnd    = [int64]$hWnd
      class   = $cls.ToString()
      title   = $txt.ToString()
      visible = [bool]$vis
    })
  }
  return $true
}

[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

foreach ($r in $results) { $r | ConvertTo-Json -Compress }
