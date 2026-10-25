# Tray icon of the Tonton Claude agent on Windows, started hidden by `tonton service`.
# It shows the status the service writes and runs `tonton token` to connect to a relay and account.
# Exit codes read by the service: 0 Quit, 2 service gone, 3 icon hidden. ASCII only: Windows PowerShell 5.1 reads it as ANSI.
param(
  [Parameter(Mandatory)] [string] $Tonton,
  [Parameter(Mandatory)] [string] $StatusFile,
  [Parameter(Mandatory)] [string] $LogFile,
  [Parameter(Mandatory)] [string] $Icon,
  [int] $ServicePid = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:exitCode = 0

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-Object System.Drawing.Icon($Icon)
$tray.Text = 'Tonton Claude'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$title = $menu.Items.Add('Tonton Claude')
$title.Enabled = $false
$state = $menu.Items.Add('Starting...')
$state.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$setToken = $menu.Items.Add('Set token...')
$openLog = $menu.Items.Add('Open log')
$hide = $menu.Items.Add('Hide this icon')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Quit')
$tray.ContextMenuStrip = $menu

# Runs the agent without a console window and returns its exit status and output.
function Invoke-Tonton([string[]] $Arguments) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Tonton
  $info.Arguments = ($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($info)
  $output = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return @{ Ok = ($process.ExitCode -eq 0); Text = $output.Trim() }
}

function Stop-Tray([int] $Code) {
  $script:exitCode = $Code
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

function Update-State {
  if ($ServicePid -and -not (Get-Process -Id $ServicePid -ErrorAction SilentlyContinue)) {
    Stop-Tray 2
    return
  }
  try {
    $status = Get-Content -Raw -Path $StatusFile | ConvertFrom-Json
  } catch {
    return
  }
  $relayHost = if ($status.relay) { ([Uri]$status.relay).Host } else { '' }
  $state.Text = switch ($status.state) {
    'connected' { "Connected to $relayHost" }
    'connecting' { "Connecting to $relayHost..." }
    'revoked' { 'Token no longer valid: set the new one' }
    default { 'Not set up' }
  }
  $title.Text = "Tonton Claude $($status.version)"
  $tooltip = "Tonton Claude - $($state.Text)"
  # NotifyIcon refuses tooltips longer than 63 characters.
  $tray.Text = if ($tooltip.Length -gt 63) { $tooltip.Substring(0, 63) } else { $tooltip }
}

$setToken.add_Click({
  $prompt = 'Paste the token from Tonton Claude > Machines on your Mac.'
  $value = [Microsoft.VisualBasic.Interaction]::InputBox($prompt, 'Set token', '').Trim()
  if (-not $value) { return }
  $result = Invoke-Tonton @('token', $value)
  $kind = if ($result.Ok) { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Error }
  [void][System.Windows.Forms.MessageBox]::Show($result.Text, 'Tonton Claude', [System.Windows.Forms.MessageBoxButtons]::OK, $kind)
  Update-State
})
$openLog.add_Click({ Start-Process notepad.exe -ArgumentList "`"$LogFile`"" })
$hide.add_Click({
  $text = "The icon comes back when you run the install command again, or with: tonton tray on"
  $answer = [System.Windows.Forms.MessageBox]::Show($text, 'Hide the Tonton Claude icon?', [System.Windows.Forms.MessageBoxButtons]::OKCancel)
  if ($answer -ne [System.Windows.Forms.DialogResult]::OK) { return }
  [void](Invoke-Tonton @('tray', 'off'))
  Stop-Tray 3
})
$quit.add_Click({ Stop-Tray 0 })

# Left click opens the same menu as right click.
$tray.add_MouseClick({
  param($source, $click)
  if ($click.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $show = [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
    $show.Invoke($tray, $null)
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ Update-State })

$tray.Visible = $true
Update-State
$timer.Start()
[System.Windows.Forms.Application]::Run()
exit $script:exitCode
