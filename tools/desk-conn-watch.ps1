# Lists the desk board's TCP connections to the planner server every few
# seconds. With keep-alive working, the same remote port should persist.
# Usage: powershell -File tools/desk-conn-watch.ps1 [-Seconds 60]
param([int]$Seconds = 60)
$board = (Resolve-DnsName planner-desk.local -Type A -ErrorAction Stop | Select-Object -First 1).IPAddress
$end = (Get-Date).AddSeconds($Seconds)
$ports = @{}
while ((Get-Date) -lt $end) {
    Get-NetTCPConnection -LocalPort 5173 -RemoteAddress $board -ErrorAction SilentlyContinue |
        Where-Object State -eq 'Established' | ForEach-Object { $ports[$_.RemotePort] = $true }
    Start-Sleep -Seconds 2
}
"board $board : distinct established connections seen in ${Seconds}s = $($ports.Count) (ports: $($ports.Keys -join ', '))"
