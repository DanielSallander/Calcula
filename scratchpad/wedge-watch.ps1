# Watch the running Calcula app from OUTSIDE and dump every thread's stack the
# moment it stops answering.
#
# The wedge stops the WebView2 message pump, so `Responding` goes False and CPU
# time stops advancing. Nothing inside the process can report at that point --
# the logger is inside the wedge -- so this observes from another process.
#
#   powershell -ExecutionPolicy Bypass -File wedge-watch.ps1 [-OutDir <dir>]

param(
    [string]$OutDir = $PSScriptRoot,
    [int]$StallSeconds = 20,
    [int]$PollMs = 2000
)

$dumper = Join-Path $PSScriptRoot "stackdump.exe"
$symdir = "C:\Users\Salle\AppData\Local\calcula-target\debug"
if (-not (Test-Path $dumper)) { throw "stackdump.exe not built" }

Write-Host "[watch] waiting for a wedge (poll ${PollMs}ms, stall ${StallSeconds}s)"
$lastCpu = $null
$stallStart = $null
$dumped = 0

while ($true) {
    $p = Get-Process -Name app -ErrorAction SilentlyContinue
    if (-not $p) {
        $lastCpu = $null; $stallStart = $null
        Start-Sleep -Milliseconds $PollMs
        continue
    }
    $cpu = $p.CPU
    $responding = $p.Responding
    $stalled = (-not $responding) -and ($null -ne $lastCpu) -and ([math]::Abs($cpu - $lastCpu) -lt 0.05)
    if ($stalled) {
        if ($null -eq $stallStart) { $stallStart = Get-Date }
        $elapsed = ((Get-Date) - $stallStart).TotalSeconds
        Write-Host ("[watch] not responding, cpu flat at {0:N2}s for {1:N0}s" -f $cpu, $elapsed)
        if ($elapsed -ge $StallSeconds) {
            $dumped++
            $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
            $out = Join-Path $OutDir "wedge-$stamp.txt"
            Write-Host "[watch] WEDGED -- dumping pid $($p.Id) to $out"
            & $dumper $p.Id --symdir $symdir --resume --maxframes 200 |
                Out-File -FilePath $out -Encoding utf8
            Write-Host "[watch] dump written ($((Get-Item $out).Length) bytes)"
            # Second dump 5s later proves the stacks are not merely slow.
            Start-Sleep -Seconds 5
            $out2 = Join-Path $OutDir "wedge-$stamp-confirm.txt"
            & $dumper $p.Id --symdir $symdir --resume --maxframes 200 |
                Out-File -FilePath $out2 -Encoding utf8
            Write-Host "[watch] confirm dump written"
            $stallStart = (Get-Date).AddSeconds(120)  # do not re-dump immediately
        }
    }
    else {
        $stallStart = $null
    }
    $lastCpu = $cpu
    Start-Sleep -Milliseconds $PollMs
}
