# Builds a DEBUG APK for the x86_64 Android emulator. It loads its JavaScript
# live from Metro (npx expo start), so UI changes can be checked without
# publishing an OTA that the real phone would pick up.
#
# Usage (from mobile/):  powershell -ExecutionPolicy Bypass -File scripts\build-debug.ps1
# Then: adb install -r android\app\build\outputs\apk\debug\app-x86_64-debug.apk
#       adb reverse tcp:8081 tcp:8081 ; adb reverse tcp:5173 tcp:5173
#
# Stop the emulator first on this PC: emulator + Gradle together run out of RAM
# (Kotlin daemon / Metaspace OOM).
$ErrorActionPreference = 'Stop'
$mobile = Split-Path -Parent $PSScriptRoot
$tools = 'C:\Users\mamou\dev-tools'

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = (Get-ChildItem "$tools\jdk" -Directory | Select-Object -First 1).FullName }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$tools\android-sdk" }
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Push-Location $mobile
try {
  # Same as the release script: the native project must match node_modules, or
  # the app dies at launch with "TurboModuleRegistry ... could not be found".
  npx expo prebuild --platform android --no-install
  if ($LASTEXITCODE -ne 0) { throw 'expo prebuild failed' }
} finally { Pop-Location }

Push-Location (Join-Path $mobile 'android')
try {
  # The release APK only ships ARM. The emulator is x86_64, so add that split
  # to the (generated, git-ignored) gradle file for this build only.
  $gradle = 'app\build.gradle'
  (Get-Content $gradle -Raw) -replace "include 'arm64-v8a', 'armeabi-v7a'\r?\n", "include 'arm64-v8a', 'armeabi-v7a', 'x86_64'`n" | Set-Content $gradle -Encoding utf8 -NoNewline
  .\gradlew.bat --stop | Out-Null
  .\gradlew.bat assembleDebug -PreactNativeArchitectures=x86_64 "-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=1g"
  if ($LASTEXITCODE -ne 0) { throw 'gradle build failed' }
  .\gradlew.bat --stop | Out-Null
  Get-ChildItem 'app\build\outputs\apk\debug\*.apk' | Select-Object Name, Length, LastWriteTime
} finally { Pop-Location }
