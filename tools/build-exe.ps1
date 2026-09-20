# Builds "Daily Planner.exe" from planner-launcher.pyw.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1
#
# The result is a single file in the repo root. It must STAY in the repo root:
# the launcher anchors itself on the .exe's own folder to find the venv, the
# widget and node_modules, so moving the .exe elsewhere breaks it. Put a
# shortcut on the desktop instead of moving the file.
#
# ANTIVIRUS. A PyInstaller one-file binary is a bootloader that unpacks a Python
# runtime into a temp folder and executes it, which is close enough to what real
# malware does that heuristic scanners flag it. Avast has already quarantined
# this project's launchers once. If the .exe disappears or refuses to start,
# that is what happened, and the fix is an exception for the repo folder, not a
# rebuild. tools\avast-exceptions.txt lists exactly what to allow.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv-launcher\Scripts\python.exe'
$entry = Join-Path $root 'planner-launcher.pyw'
$icon = Join-Path $root 'app-icon.ico'
$name = 'Daily Planner'

if (-not (Test-Path $python)) { throw "missing $python" }
if (-not (Test-Path $entry))  { throw "missing $entry" }

# Build outside the repo so PyInstaller's work folders never land in git or in
# the folder the planner itself watches for changes.
$work = Join-Path $env:TEMP 'planner-exe-build'
$distDir = Join-Path $work 'dist'

$pyiArgs = @(
  '-m', 'PyInstaller',
  '--onefile',
  # No console window, ever. This is the whole reason the launcher is a .pyw.
  '--windowed',
  '--name', $name,
  '--distpath', $distDir,
  '--workpath', (Join-Path $work 'build'),
  '--specpath', $work,
  '--noconfirm'
)
if (Test-Path $icon) { $pyiArgs += @('--icon', $icon) }
$pyiArgs += $entry

Write-Output "Building '$name.exe' ..."
# No `2>&1` here. In Windows PowerShell 5.1 redirecting a native executable's
# stderr wraps every line in an ErrorRecord and trips $ErrorActionPreference,
# so a build that succeeded with warnings (PyInstaller always emits warnings)
# would be reported as a failure. Let both streams through untouched and judge
# the build by whether the file exists.
& $python @pyiArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "PyInstaller exited with $LASTEXITCODE" }

$built = Join-Path $distDir "$name.exe"
if (-not (Test-Path $built)) { throw "PyInstaller did not produce $built" }

$target = Join-Path $root "$name.exe"
# Replacing a running .exe fails; the planner may well be up while this runs.
try {
  Copy-Item $built $target -Force
} catch {
  throw "could not replace $target (is the planner running from it?): $_"
}

$size = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Output "Wrote $target ($size MB)"
