<#
.SYNOPSIS
  Shows (or clears) a native Windows toast for the Daily Planner.

.DESCRIPTION
  Called by the planner's notification engine. This is what makes a reminder
  arrive when no planner window is open at all: the dev server is running, and
  the dev server can raise a real OS toast.

  The buttons work without the app running either. Each one activates the
  `plannernotify:` protocol, which is registered to a small silent Python agent
  that turns it straight back into an API call. So Snooze and Done are answered
  from the toast itself, and the answer is shared with the phone within seconds.

  Identity: the toast is shown under an AppUserModelID registered in HKCU, which
  is what gives it the planner's name and icon in the Action Center. If that
  registration is missing or refused, it falls back to PowerShell's own built-in
  AppUserModelID, which always works. A toast under the wrong name is far better
  than no toast at all, and this path is the last line of defence.
#>
[CmdletBinding()]
param(
  [string]$Title = 'Daily Planner',
  [string]$Body = '',
  [string]$Tag = 'planner',
  [string]$Key = '',
  [string]$User = '',
  [string]$Token = '',
  [string]$Kind = 'event',
  [string]$Priority = 'normal',
  [int]$SnoozeMinutes = 10,
  [switch]$Critical,
  [switch]$CanComplete,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$AppId = 'Mamoun.DailyPlanner'
$FallbackAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$Group = 'planner'

function Initialize-AppId {
  # Registering a display name and icon under this key is what stops the toast
  # from being attributed to "Windows PowerShell". It is idempotent and cheap,
  # so it simply runs every time rather than needing a separate install step.
  try {
    $key = "HKCU:\Software\Classes\AppUserModelId\$AppId"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name 'DisplayName' -Value 'Daily Planner' -PropertyType String -Force | Out-Null

    $icon = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) 'app-icon.png'
    if (Test-Path $icon) {
      New-ItemProperty -Path $key -Name 'IconUri' -Value $icon -PropertyType String -Force | Out-Null
    }
    # Without this the toast is silent about which app it came from on some builds.
    New-ItemProperty -Path $key -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
  } catch {
    # Not fatal. The fallback AppUserModelID below still shows the toast.
  }
}

function Get-Notifier {
  param([string]$Id)
  return [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Id)
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null

Initialize-AppId

if ($Remove) {
  # Clearing is best effort: the toast may already be gone, and the history API
  # throws rather than returning false when it is.
  foreach ($id in @($AppId, $FallbackAppId)) {
    try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($Tag, $Group, $id) } catch { }
  }
  exit 0
}

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  return [System.Security.SecurityElement]::Escape($s)
}

# Every button and the toast body itself carry the notification key, the user
# and the loopback-only agent token, so the agent can answer without a session.
$q = "key=$([uri]::EscapeDataString($Key))&user=$([uri]::EscapeDataString($User))&token=$([uri]::EscapeDataString($Token))"
$openArg = Esc "plannernotify:open?$q"
$readArg = Esc "plannernotify:read?$q"
$snoozeArg = Esc "plannernotify:snooze?$q&minutes=$SnoozeMinutes"
$doneArg = Esc "plannernotify:done?$q"
$ackArg = Esc "plannernotify:ack?$q"

$actions = New-Object System.Text.StringBuilder
if ($Critical) {
  # Acknowledge is the only thing that stops a critical item repeating, so it
  # goes first and is the button under the thumb.
  [void]$actions.Append("<action content='Acknowledge' activationType='protocol' arguments='$ackArg'/>")
}
[void]$actions.Append("<action content='Snooze $SnoozeMinutes min' activationType='protocol' arguments='$snoozeArg'/>")
if ($CanComplete) {
  [void]$actions.Append("<action content='Done' activationType='protocol' arguments='$doneArg'/>")
} else {
  [void]$actions.Append("<action content='Mark read' activationType='protocol' arguments='$readArg'/>")
}

$scenario = if ($Critical) { ' scenario="reminder"' } else { '' }
$audio = if ($Critical) {
  '<audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="true"/>'
} else {
  '<audio src="ms-winsoundevent:Notification.Reminder"/>'
}

# Per-kind artwork, so a prayer reminder does not look like a calendar entry.
$artName = if ($Critical) { 'critical' } else {
  switch ($Kind) {
    'task' { 'task' }
    'task-digest' { 'task-digest' }
    'prayer' { 'prayer' }
    default { 'event' }
  }
}
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$artPath = Join-Path $root ('artifacts' + [IO.Path]::DirectorySeparatorChar + 'weekly-planner' + [IO.Path]::DirectorySeparatorChar + 'public' + [IO.Path]::DirectorySeparatorChar + 'notify' + [IO.Path]::DirectorySeparatorChar + "icon-$artName.png")
$logo = if (Test-Path $artPath) {
  "<image placement='appLogoOverride' hintCrop='circle' src='$(Esc $artPath)'/>"
} else { '' }

$attribution = switch ($Kind) {
  'task' { 'Task' }
  'task-digest' { 'Tasks' }
  'prayer' { 'Prayer' }
  default { 'Daily Planner' }
}

$xml = @"
<toast$scenario launch="$openArg" activationType="protocol">
  <visual>
    <binding template="ToastGeneric">
      $logo
      <text>$(Esc $Title)</text>
      <text>$(Esc $Body)</text>
      <text placement="attribution">$(Esc $attribution)</text>
    </binding>
  </visual>
  <actions>
    $($actions.ToString())
  </actions>
  $audio
</toast>
"@

$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)

$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
$toast.Tag = $Tag
$toast.Group = $Group
# A normal reminder is not worth keeping once it is well out of date; a critical
# one stays in the Action Center until it is dealt with.
if (-not $Critical) {
  $toast.ExpirationTime = [DateTimeOffset]::Now.AddHours(12)
}

try {
  (Get-Notifier -Id $AppId).Show($toast)
} catch {
  # A fresh copy is required: a ToastNotification cannot be shown twice.
  $retry = New-Object Windows.UI.Notifications.ToastNotification $doc
  $retry.Tag = $Tag
  $retry.Group = $Group
  (Get-Notifier -Id $FallbackAppId).Show($retry)
}

exit 0
