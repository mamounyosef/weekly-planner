# Registers the scheduled task that keeps the public link alive.
# Idempotent: run it again to update the task after editing the watchdog.
# Needs no admin: the task runs as the logged-on user, like the planner itself.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-link-watchdog.ps1
#
# Remove with:  schtasks /delete /tn "Daily Planner Link Watchdog" /f

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'tools\link-watchdog.pyw'
$pythonw = Join-Path $root '.venv-launcher\Scripts\pythonw.exe'
$taskName = 'Daily Planner Link Watchdog'

if (-not (Test-Path $script))  { throw "missing $script" }
if (-not (Test-Path $pythonw)) { throw "missing $pythonw" }

# Written as XML rather than built with New-ScheduledTask* because the repeat
# forever trigger is the whole point and PowerShell cannot express an unbounded
# repetition without the same XML anyway.
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Reconnects Tailscale, re-asserts the funnel and restarts the planner dev server whenever the public URL stops answering.</Description>
    <URI>\$taskName</URI>
  </RegistrationInfo>
  <Triggers>
    <!-- The repeat lives on a time trigger, NOT on the logon trigger. A logon
         trigger only begins its repetition at the next logon, so installing the
         task mid-session would leave it armed but never running until reboot.
         A start boundary in the past plus StartWhenAvailable makes the cycle
         begin immediately and survive sleep and reboots. -->
    <CalendarTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <!-- The planner launcher is starting the dev server at this moment; give
           it a head start so the first check is not a guaranteed miss. -->
      <Delay>PT2M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <!-- A laptop on battery is exactly when the link matters most. -->
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <!-- Well above the worst case (a relaunch waits up to 60s for the server),
         but short enough that a wedged run cannot block the next one forever. -->
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
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

$tmp = Join-Path $env:TEMP 'planner-link-watchdog.xml'
# Task Scheduler insists on UTF-16 for an imported XML that declares it.
[System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)

schtasks /create /tn "$taskName" /xml "$tmp" /f | Out-Null
Remove-Item $tmp -ErrorAction SilentlyContinue

# Start one pass now so the link is verified before this script returns.
schtasks /run /tn "$taskName" | Out-Null

Write-Output "Registered '$taskName' (every 5 minutes, and at logon)."
