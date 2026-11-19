# Run this repo's tests on Windows, then print a result block to paste back.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\test-windows.ps1
#
# It creates .venv-win, installs the repo's declared dependencies plus pytest, finds every tests
# directory, runs each one, and writes RESULT.txt. Nothing outside this folder is touched.

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Section($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }

Section "machine"
$os = [System.Environment]::OSVersion.VersionString
Write-Host "host   : $env:COMPUTERNAME"
Write-Host "os     : $os"
Write-Host "shell  : PowerShell $($PSVersionTable.PSVersion)"

Section "python"
$py = $null
foreach ($cand in @("python", "py", "python3")) {
    $p = Get-Command $cand -ErrorAction SilentlyContinue
    if ($p) { $py = $p.Source; break }
}
if (-not $py) {
    Write-Host "No Python found. Install Python 3.12 from python.org and tick 'Add python.exe to PATH'." -ForegroundColor Red
    exit 2
}
& $py --version
$pyVersion = (& $py --version 2>&1) -join " "

Section "virtual environment"
if (-not (Test-Path ".venv-win")) { & $py -m venv .venv-win }
$venvPy = Join-Path $root ".venv-win\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { Write-Host "venv creation failed" -ForegroundColor Red; exit 2 }

Section "dependencies"
& $venvPy -m pip install --quiet --upgrade pip
foreach ($f in @("requirements.txt", "requirements-dev.txt")) {
    if (Test-Path $f) { Write-Host "installing $f"; & $venvPy -m pip install --quiet -r $f }
}
if (Test-Path "pyproject.toml") {
    Write-Host "installing package (editable)"
    & $venvPy -m pip install --quiet -e . 2>&1 | Select-Object -Last 3
}
& $venvPy -m pip install --quiet pytest

Section "finding tests"
$suites = Get-ChildItem -Recurse -Directory -Filter "tests" |
    Where-Object { $_.FullName -notmatch "node_modules|\.venv|site-packages|__pycache__|\\tools\\" } |
    ForEach-Object { $_.FullName } | Sort-Object
if (-not $suites) { Write-Host "No tests directory found anywhere in this repo." -ForegroundColor Yellow }
$suites | ForEach-Object { Write-Host "  $_" }

Section "running"
$summary = @()
$overall = 0
foreach ($suite in $suites) {
    $rel = $suite.Substring($root.Length).TrimStart("\")
    $line = "---- $rel ----"
    Write-Host $line -ForegroundColor Yellow
    $out = & $venvPy -m pytest $suite -o addopts="" -q -p no:cacheprovider 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and $code -ne 5) { $overall = $code }
    $out | Select-Object -Last 12 | ForEach-Object { Write-Host $_ }
    $tail = ($out | Select-String -Pattern "\d+ (passed|failed|error)" | Select-Object -Last 1).Line
    if (-not $tail) { $tail = "exit $code, no summary line" }
    $summary += "$rel :: $tail"
}

Section "git"
$rev = ""
if (Get-Command git -ErrorAction SilentlyContinue) { $rev = (& git rev-parse --short HEAD 2>$null) }

$report = @()
$report += "plugin:    $((Split-Path $root -Leaf))"
$report += "host:      $env:COMPUTERNAME"
$report += "os:        $os"
$report += "python:    $pyVersion"
$report += "commit:    $rev"
$report += "exit:      $overall"
$report += "suites:"
$summary | ForEach-Object { $report += "  $_" }
$report += "run at:    $(Get-Date -Format o)"
$report | Set-Content -Path (Join-Path $root "RESULT.txt")

Section "RESULT"
$report | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "RESULT.txt written to $root\RESULT.txt - send that file back." -ForegroundColor Green
exit $overall
