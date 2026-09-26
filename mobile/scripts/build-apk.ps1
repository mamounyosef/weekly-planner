# Builds the signed release APK that the planner serves at /app.apk.
# Only needed when the NATIVE half changes (a new native module, a permission,
# a config plugin), and then `runtimeVersion` in app.json must be bumped too.
# Plain JavaScript changes ship with `npm run publish` instead.
#
# Usage (from mobile/):  powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
$ErrorActionPreference = 'Stop'
$mobile = Split-Path -Parent $PSScriptRoot
$tools = 'C:\Users\mamou\dev-tools'

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = (Get-ChildItem "$tools\jdk" -Directory | Select-Object -First 1).FullName }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$tools\android-sdk" }
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Push-Location $mobile
try {
  Write-Output 'Typechecking ...'
  npx tsc --noEmit
  if ($LASTEXITCODE -ne 0) { throw 'typecheck failed; not building' }

  # A Gradle daemon left over from an earlier build keeps jars in
  # node_modules/**/build locked on Windows, and the next build then fails
  # with "Unable to delete file ...classes.jar". Stop it first.
  if (Test-Path 'android\gradlew.bat') {
    Push-Location android
    try { .\gradlew.bat --stop | Out-Null } finally { Pop-Location }
  }

  Write-Output 'Syncing native project (expo prebuild) ...'
  npx expo prebuild --platform android --no-install
  if ($LASTEXITCODE -ne 0) { throw 'expo prebuild failed' }

  Write-Output 'Building release APK ...'
  Push-Location android
  try {
    .\gradlew.bat assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'gradle build failed' }
  } finally { Pop-Location }

  Get-ChildItem 'android\app\build\outputs\apk\release\*.apk' | Select-Object Name, Length, LastWriteTime
} finally { Pop-Location }
