# Registers the scheduled task that starts the Daily Planner when you log in.
# Idempotent: run it again to update the task after moving or renaming things.
# Needs no admin: the task runs as the logged-on user, like the planner itself.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
#
# Remove with:  schtasks /delete /tn "Daily Planner Autostart" /f
#
# WHY A TASK AND NOT THE STARTUP FOLDER.
#
# The planner was supposed to start from a shortcut in the Windows Startup
# folder. On 2026-09-20 that folder was found to contain no planner entry at
# all, which is exactly why the app stopped launching after a restart. A
# shortcut in Startup is a single file with nothing watching it: antivirus
# quarantines it (which has already happened once to this project, and is why
# the launcher is a .pyw rather than the original .vbs/.bat chain), an installer
# clears it, or it is deleted by hand, and there is no signal of any kind.
#
# A scheduled task is inspectable (`schtasks /query`), it records its last run
# and last result, it retries on failure, and the planner's own server verifies
# on every startup that it still exists and re-registers it when it does not.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'planner-launcher.pyw'
$pythonw = Join-Path $root '.venv-launcher\Scripts\pythonw.exe'
$taskName = 'Daily Planner Autostart'

if (-not (Test-Path $script))  { throw "missing $script" }
if (-not (Test-Path $pythonw)) { throw "missing $pythonw" }

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the Daily Planner (dev server, app window, side widget and focus hotkey) at logon. The launcher is mutex-guarded, so running it when the planner is already up starts nothing.</Description>
    <URI>\$taskName</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <!-- A short delay, not none. At logon the network stack and the Tailscale
           service are still coming up, and the launcher waits on the dev server
           answering rather than on a fixed sleep, so starting a few seconds
           late costs nothing and starting instantly can cost a failed boot. -->
      <Delay>PT15S</Delay>
    </LogonTrigger>
    <!-- Unlocking after sleep is not a logon, so the trigger above does not
         fire for it. This one covers the case where the planner died while the
         machine was asleep or suspended. The launcher's mutex makes it a no-op
         whenever the planner is already running, so an extra trigger is free. -->
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <StateChange>SessionUnlock</StateChange>
      <Delay>PT15S</Delay>
    </SessionStateChangeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <!-- IgnoreNew, because the launcher is mutex-guarded anyway and a second
         copy would simply exit. Better to let the first one finish. -->
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <!-- If the machine was off at the scheduled moment, run as soon as it can. -->
    <StartWhenAvailable>true</StartWhenAvailable>
    <!-- The launcher waits for the server itself and must not be blocked on a
         network check that can be wrong at logon. -->
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <!-- Hidden, so Task Scheduler never shows a window for this run.
         The action is a windowless interpreter already, but a task left
         visible is one misconfigured action away from flashing a console
         in the user's face every five minutes. -->
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <!-- The launcher waits up to 120s for the dev server, then spawns the
         windows and exits. Five minutes is generous; past that it is wedged. -->
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>6</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"$pythonw"</Command>
      <Arguments>"$script"</Arguments>
      <WorkingDirectory>$root</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = Join-Path $env:TEMP 'planner-autostart.xml'
# Task Scheduler insists on UTF-16 for an imported XML that declares it.
[System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)

schtasks /create /tn "$taskName" /xml "$tmp" /f | Out-Null
Remove-Item $tmp -ErrorAction SilentlyContinue

Write-Output "Registered '$taskName' (at logon, and on unlock)."
