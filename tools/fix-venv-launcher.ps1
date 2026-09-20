# Makes .venv-launcher launch python without ever flashing a console window.
#
# THE BUG THIS FIXES. `.venv-launcher\Scripts\pythonw.exe` was not an
# interpreter, it was CPython's *venv redirector*: a small stub that reads
# `pyvenv.cfg` and starts the real interpreter as a CHILD process. The stub
# itself is a GUI-subsystem binary, so it is silent -- but it launches whatever
# `pyvenv.cfg`'s `executable` key names, and that key says `python.exe`, the
# CONSOLE build. Every launch therefore created a console, and on Windows 11
# a new console means Windows Terminal pops a window on screen. The scheduled
# "Daily Planner Link Watchdog" task runs through that stub, which is why a
# terminal appeared, sat there for about a second and vanished, over and over,
# all day long.
#
# THE FIX. Replace both stubs with genuine copies of the base interpreters.
# That is exactly what `python -m venv --copies` produces on Windows, and it is
# fully supported: the copied exe finds its DLLs through the base install and
# still resolves the venv from the `pyvenv.cfg` sitting one directory up, so
# sys.prefix, site-packages and pip keep working. With a real pythonw.exe in
# place there is no child process and no console, ever.
#
# Idempotent: re-running it when the copies are already correct does nothing.
# Re-run it after recreating the venv, which puts the stubs back.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repo '.venv-launcher'
$cfg = Join-Path $venv 'pyvenv.cfg'
$scripts = Join-Path $venv 'Scripts'

if (-not (Test-Path $cfg)) {
    Write-Host "[venv] no .venv-launcher at $venv - nothing to fix"
    exit 0
}

# The base interpreter is whatever the venv itself says it was built from, so
# this keeps working if Python is ever reinstalled somewhere else.
$home_ = $null
foreach ($line in Get-Content $cfg) {
    if ($line -match '^\s*home\s*=\s*(.+?)\s*$') { $home_ = $Matches[1] }
}
if (-not $home_ -or -not (Test-Path $home_)) {
    Write-Warning "[venv] pyvenv.cfg does not point at a usable base install ('$home_'); leaving the venv alone"
    exit 0
}

<#
.SYNOPSIS
Reads a PE file's subsystem: 2 = GUI (never shows a console), 3 = console.
#>
function Get-PeSubsystem {
    param([string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $br = New-Object System.IO.BinaryReader($fs)
        $fs.Position = 0x3C
        $peOffset = $br.ReadInt32()
        # PE signature (4) + COFF header (20) + Subsystem's offset in the optional header (68)
        $fs.Position = $peOffset + 4 + 20 + 68
        return $br.ReadUInt16()
    } finally { $fs.Dispose() }
}

$changed = $false

foreach ($name in @('python.exe', 'pythonw.exe')) {
    $source = Join-Path $home_ $name
    $target = Join-Path $scripts $name

    if (-not (Test-Path $source)) {
        Write-Warning "[venv] $source is missing from the base install; skipping $name"
        continue
    }

    # A genuine copy is byte-identical to the base interpreter. Anything else
    # is the redirector stub (or a stale copy from an older Python).
    if (Test-Path $target) {
        $same = (Get-FileHash $source -Algorithm SHA256).Hash -eq (Get-FileHash $target -Algorithm SHA256).Hash
        if ($same) { continue }
    }

    New-Item -ItemType Directory -Path $scripts -Force | Out-Null

    # A running planner holds these open, so a plain copy fails with "in use".
    # Move the old one aside first: Windows allows renaming a file that is open,
    # and the leftover is cleaned up on the next run.
    if (Test-Path $target) {
        $stale = "$target.stub-$(Get-Date -Format 'yyyyMMddHHmmss').bak"
        try { Move-Item $target $stale -Force } catch {
            Write-Warning "[venv] could not replace $name (it is in use): $($_.Exception.Message)"
            continue
        }
    }

    Copy-Item $source $target -Force
    $changed = $true
    Write-Host "[venv] replaced Scripts\$name with the real interpreter from $home_"
}

# Sweep the aside-moved stubs from previous runs once nothing holds them.
Get-ChildItem (Join-Path $scripts '*.stub-*.bak') -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force } catch { }
}

foreach ($name in @('python.exe', 'pythonw.exe')) {
    $target = Join-Path $scripts $name
    if (-not (Test-Path $target)) { continue }
    $sub = Get-PeSubsystem $target
    $expected = if ($name -eq 'pythonw.exe') { 2 } else { 3 }
    if ($sub -ne $expected) {
        Write-Warning "[venv] Scripts\$name has subsystem $sub, expected $expected"
    }
}

if (-not $changed) { Write-Host '[venv] launcher interpreters are already consoleless - nothing to do' }
