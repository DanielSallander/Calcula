# Answer a NATIVE dialog raised by the Calcula app (tauri-plugin-dialog -> rfd ->
# Win32 TaskDialog/MessageBox). Playwright cannot touch these: Tauri defines its
# IPC surface with non-writable/non-configurable properties, so the dialog can be
# neither stubbed nor observed from inside the page. It CAN be driven from
# outside, which is what this does.
#
#   -TitleLike  substring of the dialog's window title (e.g. "Script Security").
#               Pass "Calcula" for a confirmAsync raised without a title option.
#   -Action     ok | cancel | read     ("read" reports the text and clicks nothing)
#
# Finds the dialog owned by app.exe, enumerates its child BUTTONs, and posts
# BM_CLICK to the matching one. Clicking the real button is used in preference to
# SendKeys because it does not depend on focus, on the window being foreground,
# or on which button the dialog nominated as default.
#
# Emits:
#   TEXT:<message>        the dialog's message text, read via UI Automation
#   CLICKED:<button text> | NOTFOUND | NOBUTTON:<texts>
#
# The message is read through UIAutomation rather than GetWindowText because rfd
# raises a TASKDIALOG whose body is DirectUI — Win32 text APIs return nothing for
# it. In the UIA tree the dialog is a CHILD of the "Tauri Window" element (it is
# an owned dialog), not a separate top-level window.
param(
  [Parameter(Mandatory = $true)][string]$TitleLike,
  [Parameter(Mandatory = $true)][ValidateSet("ok", "cancel", "read")][string]$Action,
  [int]$TimeoutMs = 20000
)
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DlgWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
}
"@

function Get-AppPids { @(Get-Process -Name "app" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) }

function Find-Dialog {
  param([string]$titleLike)
  $procIds = Get-AppPids
  if ($procIds.Count -eq 0) { return [IntPtr]::Zero }
  $found = [IntPtr]::Zero
  $cb = [DlgWin+EnumProc]{
    param($hWnd, $lParam)
    $p = 0
    [DlgWin]::GetWindowThreadProcessId($hWnd, [ref]$p) | Out-Null
    if ($procIds -contains [int]$p -and [DlgWin]::IsWindowVisible($hWnd)) {
      $txt = New-Object System.Text.StringBuilder 512
      [DlgWin]::GetWindowText($hWnd, $txt, 512) | Out-Null
      $cls = New-Object System.Text.StringBuilder 256
      [DlgWin]::GetClassName($hWnd, $cls, 256) | Out-Null
      $t = $txt.ToString()
      $c = $cls.ToString()
      # A TaskDialog/MessageBox is class #32770; the main webview window is not.
      if ($c -eq "#32770" -and $t -like "*$titleLike*") {
        $script:found = $hWnd
        return $false
      }
    }
    return $true
  }
  [DlgWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

# --- wait for the dialog ---
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$dlg = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $script:found = [IntPtr]::Zero
  $dlg = Find-Dialog -titleLike $TitleLike
  if ($dlg -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
}
if ($dlg -eq [IntPtr]::Zero) { Write-Output "NOTFOUND"; exit 0 }

# --- read the message text (UI Automation) ---
# GetWindowText cannot see it: the TaskDialog body is DirectUI, so Win32 text
# APIs return nothing. The search is anchored with FromHandle on THIS dialog's
# HWND — walking top-level windows instead would also sweep up the webview's own
# Text elements (the whole ribbon: "Clipboard", "Font", "Alignment", …) and
# report them as dialog text, which would make a `toContain` assertion pass on
# content the dialog never showed.
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($dlg)
  $textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
  $texts = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
  $seen = New-Object System.Collections.Generic.HashSet[string]
  foreach ($t in $texts) {
    $n = $t.Current.Name
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    if ($n -eq "MainInstructionIcon") { continue }
    $flat = ($n -replace "`r`n", " " -replace "`n", " ")
    if ($seen.Add($flat)) { Write-Output ("TEXT:" + $flat) }
  }
} catch {
  Write-Output ("TEXTERROR:" + $_.Exception.Message)
}

if ($Action -eq "read") { exit 0 }

# --- enumerate child buttons ---
$buttons = New-Object System.Collections.ArrayList
$cbChild = [DlgWin+EnumProc]{
  param($hWnd, $lParam)
  $cls = New-Object System.Text.StringBuilder 256
  [DlgWin]::GetClassName($hWnd, $cls, 256) | Out-Null
  if ($cls.ToString() -eq "Button") {
    $txt = New-Object System.Text.StringBuilder 512
    [DlgWin]::GetWindowText($hWnd, $txt, 512) | Out-Null
    $id = [DlgWin]::GetDlgCtrlID($hWnd)
    $null = $buttons.Add([pscustomobject]@{ hwnd = $hWnd; text = $txt.ToString(); id = $id })
  }
  return $true
}
[DlgWin]::EnumChildWindows($dlg, $cbChild, [IntPtr]::Zero) | Out-Null

# Strip the & accelerator marker before reporting.
function Strip-Accel([string]$s) { return ($s -replace "&", "").Trim() }

# PICKING THE BUTTON. Two traps, both hit for real while building this:
#
#   1. The dialog is rendered in the SYSTEM locale, not the app's. On this
#      machine (sv-SE) the Cancel button reads "Avbryt", so matching the literal
#      "Cancel" finds nothing — and a refusal case that never finds its button
#      would pass without ever pressing Cancel. That is the exact shape of
#      false-pass this whole exercise exists to eliminate.
#   2. rfd raises a TASKDIALOG, not a classic MessageBox, so GetDlgCtrlID
#      returns 0 for every button — the locale-invariant IDOK/IDCANCEL trick
#      does not apply either.
#
# So: match an OK-like label from a multi-locale list, and treat "the button
# that is not the OK one" as Cancel, with strict positional fallback for a
# two-button dialog. The chosen label is ECHOED so the caller can assert which
# button was actually pressed rather than trusting that one was.
$okLike = @("OK", "Ok", "Yes", "Ja")

$okButton = $null
foreach ($b in $buttons) { if ($okLike -contains (Strip-Accel $b.text)) { $okButton = $b; break } }

$target = $null
if ($Action -eq "ok") {
  if ($null -ne $okButton) { $target = $okButton }
  elseif ($buttons.Count -ge 1) { $target = $buttons[0] }
} else {
  foreach ($b in $buttons) {
    if ($null -eq $okButton -or $b.hwnd -ne $okButton.hwnd) { $target = $b }
  }
  # $target is now the LAST non-OK button, which for a 2-button confirm is Cancel.
  if ($null -eq $target -and $buttons.Count -ge 2) { $target = $buttons[$buttons.Count - 1] }
}

if ($null -eq $target) {
  $all = ($buttons | ForEach-Object { Strip-Accel $_.text }) -join "|"
  Write-Output "NOBUTTON:$all"
  exit 0
}

$BM_CLICK = 0x00F5
[DlgWin]::SendMessage($target.hwnd, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Write-Output ("CLICKED:" + (Strip-Accel $target.text))
