# Answer a NATIVE dialog raised by the Calcula app (tauri-plugin-dialog -> rfd ->
# Win32 TaskDialog/MessageBox). Playwright cannot touch these: Tauri defines its
# IPC surface with non-writable/non-configurable properties, so the dialog can be
# neither stubbed nor observed from inside the page. It CAN be driven from
# outside, which is what this does.
#
#   -TitleLike  substring of the dialog's window title (e.g. "Script Security").
#               Pass "Calcula" for a confirmAsync raised without a title option.
#   -Action     ok | cancel | read     ("read" reports the text and clicks nothing)
#               button                 press the button whose label is EXACTLY -Button
#               close                  the title-bar X (WM_SYSCOMMAND / SC_CLOSE)
#               escape                 the Escape key, delivered to the dialog itself
#   -Button     with -Action button: the label to press ("&" accelerators ignored)
#
# Finds the dialog owned by app.exe, enumerates its child BUTTONs, and posts
# BM_CLICK to the matching one. Clicking the real button is used in preference to
# SendKeys because it does not depend on focus, on the window being foreground,
# or on which button the dialog nominated as default.
#
# Emits:
#   TEXT:<message>        the dialog's message text, read via UI Automation
#   CLICKED:<button text> | NOTFOUND | NOBUTTON:<texts>
# and, for the three by-name actions (button / close / escape) only:
#   BUTTONS:<a>|<b>|...   every button the dialog offered, in window order
#   CLICKED:<label> | CLOSED:X | ESCAPED   what was sent
#   GONE | STILLOPEN      whether the dialog window was destroyed within 5 s --
#                         the caller's proof that the answer was DELIVERED, not
#                         merely sent (an X that is disabled is silently ignored)
#
# WHY "button" EXISTS. "cancel" presses "the last button that is not OK-like",
# which is right for a two-button confirm and a GUESS for three custom labels:
# on the save-before-closing prompt (Save / Don't Save / Cancel) a wrong guess
# presses Don't Save and destroys the app under test. A by-label press either
# finds the named button or reports NOBUTTON and presses nothing.
#
# The message is read through UIAutomation rather than GetWindowText because rfd
# raises a TASKDIALOG whose body is DirectUI — Win32 text APIs return nothing for
# it. In the UIA tree the dialog is a CHILD of the "Tauri Window" element (it is
# an owned dialog), not a separate top-level window.
param(
  [Parameter(Mandatory = $true)][string]$TitleLike,
  [Parameter(Mandatory = $true)][ValidateSet("ok", "cancel", "read", "button", "close", "escape")][string]$Action,
  [int]$TimeoutMs = 20000,
  [string]$Button = ""
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
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
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
# RETRIED, and wider than Text elements. A TaskDialog that is still painting
# its DirectUI body exposes no Text children for a moment, and a long or
# multi-line body (a confirm that SHOWS code) can surface as a Document or Edit
# element instead -- run 10 (2026-10-01) read "Make this my own" with custom
# buttons and got no TEXT line at all, so "the confirm shows the code" could not
# be asserted. Up to ~2 s, until at least one text line is seen.
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($dlg)
  $types = @(
    [System.Windows.Automation.ControlType]::Text,
    [System.Windows.Automation.ControlType]::Document,
    [System.Windows.Automation.ControlType]::Edit
  )
  $seen = New-Object System.Collections.Generic.HashSet[string]
  $textDeadline = (Get-Date).AddMilliseconds(2000)
  do {
    foreach ($ct in $types) {
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
      $found = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($t in $found) {
        $n = $t.Current.Name
        if ([string]::IsNullOrWhiteSpace($n)) {
          # A Document/Edit body carries its text in a pattern, not its Name.
          try {
            $vp = $t.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $n = $vp.Current.Value
          } catch {
            try {
              $tp = $t.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
              $n = $tp.DocumentRange.GetText(-1)
            } catch { $n = $null }
          }
        }
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        if ($n -eq "MainInstructionIcon") { continue }
        $flat = ($n -replace "`r`n", " " -replace "`n", " ")
        if ($seen.Add($flat)) { Write-Output ("TEXT:" + $flat) }
      }
    }
    if ($seen.Count -gt 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $textDeadline)
  if ($seen.Count -eq 0) { Write-Output "TEXTNONE:no Text, Document or Edit element carried text within 2 s" }
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

# --- the by-name actions: button / close / escape ---
# Each reports every button it saw, what it sent, and whether the dialog then
# went away. "Sent" is not "answered": a TaskDialog without
# TDF_ALLOW_DIALOG_CANCELLATION greys its X and ignores Escape, and a caller that
# trusted the send would then assert on an app still blocked by the prompt.
function Wait-DialogGone([IntPtr]$h) {
  $until = (Get-Date).AddMilliseconds(5000)
  while ((Get-Date) -lt $until) {
    if (-not [DlgWin]::IsWindow($h) -or -not [DlgWin]::IsWindowVisible($h)) { return "GONE" }
    Start-Sleep -Milliseconds 100
  }
  return "STILLOPEN"
}

if ($Action -eq "button" -or $Action -eq "close" -or $Action -eq "escape") {
  Write-Output ("BUTTONS:" + (($buttons | ForEach-Object { Strip-Accel $_.text }) -join "|"))
  if ($Action -eq "button") {
    if ([string]::IsNullOrWhiteSpace($Button)) { Write-Output "NOBUTTON:(no -Button label given)"; exit 0 }
    $named = $null
    foreach ($b in $buttons) { if ((Strip-Accel $b.text) -eq $Button) { $named = $b; break } }
    if ($null -eq $named) {
      Write-Output ("NOBUTTON:" + (($buttons | ForEach-Object { Strip-Accel $_.text }) -join "|"))
      exit 0
    }
    [DlgWin]::SendMessage($named.hwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Write-Output ("CLICKED:" + (Strip-Accel $named.text))
  } elseif ($Action -eq "close") {
    # Exactly what a click on the title-bar X sends. Posted, so a dialog that
    # refuses it cannot block this script.
    $WM_SYSCOMMAND = 0x0112
    $SC_CLOSE = 0xF060
    [DlgWin]::PostMessage($dlg, $WM_SYSCOMMAND, [IntPtr]$SC_CLOSE, [IntPtr]::Zero) | Out-Null
    Write-Output "CLOSED:X"
  } else {
    # Escape as the dialog's own modal loop receives a keypress: a key message
    # for a control INSIDE the dialog, which IsDialogMessage turns into
    # IDCANCEL. Posted to the dialog's control rather than synthesised with
    # SendInput, so it cannot land in whatever window is in the foreground.
    if ($buttons.Count -eq 0) { Write-Output "NOBUTTON:"; exit 0 }
    $WM_KEYDOWN = 0x0100
    $WM_KEYUP = 0x0101
    $VK_ESCAPE = 0x1B
    $h = $buttons[0].hwnd
    [DlgWin]::PostMessage($h, $WM_KEYDOWN, [IntPtr]$VK_ESCAPE, [IntPtr]0x00010001) | Out-Null
    [DlgWin]::PostMessage($h, $WM_KEYUP, [IntPtr]$VK_ESCAPE, [IntPtr][Int64]3221291009) | Out-Null
    Write-Output "ESCAPED"
  }
  Write-Output (Wait-DialogGone $dlg)
  exit 0
}

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
