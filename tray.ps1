param(
  [string]$ProjectDirectory = (Split-Path -Parent $MyInvocation.MyCommand.Path),
  [switch]$Autostart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LmdNativeWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr windowHandle, int command);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr windowHandle);
}
"@
[System.Windows.Forms.Application]::EnableVisualStyles()

$ProjectDirectory = [System.IO.Path]::GetFullPath($ProjectDirectory)
$nodeExecutable = Join-Path $ProjectDirectory "runtime\node.exe"
# 完整分发版自带 runtime\node.exe；开发目录没有 runtime 时回退到系统 PATH
# 中的 node，保证两种环境都能正常启动共享服务。
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $systemNode -and $systemNode.Source) {
    $nodeExecutable = $systemNode.Source
  }
}
$serverEntry = Join-Path $ProjectDirectory "server\index.mjs"
$qrHelper = Join-Path $ProjectDirectory "tray-qr.mjs"
$port = if ($env:LMD_PORT) { [int]$env:LMD_PORT } else { 8096 }
$healthUrl = "http://127.0.0.1:$port/api/health"
$adminUrl = "http://127.0.0.1:$port/admin"
$stopUrl = "http://127.0.0.1:$port/api/service/stop"
$qrImagePath = Join-Path ([System.IO.Path]::GetTempPath()) ("LMD-tray-qr-{0}.png" -f $PID)
$runningTrayIconPath = Join-Path $ProjectDirectory "assets\tray-running.ico"
$stoppedTrayIconPath = Join-Path $ProjectDirectory "assets\tray-stopped.ico"
$trayLogPath = Join-Path ([System.IO.Path]::GetTempPath()) "LMD-tray.log"

function Write-TrayLog([string]$message) {
  try {
    Add-Content -LiteralPath $trayLogPath -Encoding UTF8 -Value ("{0:o} [PID {1}] {2}" -f [DateTime]::Now, $PID, $message)
  } catch { }
}

$mutexName = "Local\LMD.Tray.Controller"
$activationEventName = "Local\LMD.Tray.Activate"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  Write-TrayLog "existing tray detected; requesting control panel"
  try {
    $existingEvent = [System.Threading.EventWaitHandle]::OpenExisting($activationEventName)
    [void]$existingEvent.Set()
    $existingEvent.Dispose()
    Write-TrayLog "activation signal sent"
  } catch {
    Write-TrayLog ("activation signal failed: {0}" -f $_.Exception.Message)
  }
  $mutex.Dispose()
  exit 0
}

$activationEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $activationEventName)
Write-TrayLog ("tray started; autostart={0}" -f $Autostart)
$script:serviceRunning = $false
$script:primaryViewingUrl = ""
$script:lastQrUrl = ""
$script:isUpdating = $false
$script:allowFormClose = $false
$script:trayIconState = ""
# 崩溃看门狗状态：manualStop 表示用户主动停止（不自动重启）；
# wasServiceRunning 表示服务曾成功运行（只有“运行中崩溃”才自动恢复）；
# watchdogFailures 连续失败计数，超过上限后放弃自动重启。
$script:manualStop = $false
$script:wasServiceRunning = $false
$script:watchdogFailures = 0

function New-UiFont([float]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
  return New-Object System.Drawing.Font("Microsoft YaHei UI", $size, $style, [System.Drawing.GraphicsUnit]::Point)
}

function Get-LmdHealth {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 1
    if ($health.name -eq "LMD" -and $health.ok) { return $health }
  } catch { }
  return $null
}

function Show-TrayMessage([string]$title, [string]$message, [System.Windows.Forms.ToolTipIcon]$icon = [System.Windows.Forms.ToolTipIcon]::Info) {
  $notifyIcon.ShowBalloonTip(2200, $title, $message, $icon)
}

function Set-TrayServiceIcon([bool]$running) {
  $nextState = if ($running) { "running" } else { "stopped" }
  if ($script:trayIconState -eq $nextState) { return }

  $nextIcon = if ($running) { $runningTrayIcon } else { $stoppedTrayIcon }
  $notifyIcon.Icon = $nextIcon
  $notifyIcon.Text = if ($running) { "LMD 共享服务：运行中" } else { "LMD 共享服务：已停止" }
  $form.Icon = $nextIcon
  $script:trayIconState = $nextState
}

function Clear-QrImage {
  if ($qrPicture.Image) {
    $oldImage = $qrPicture.Image
    $qrPicture.Image = $null
    $oldImage.Dispose()
  }
  $script:lastQrUrl = ""
}

function Set-QrImage([string]$url) {
  if (-not $url -or ($script:lastQrUrl -eq $url -and $qrPicture.Image)) { return }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeExecutable
  $startInfo.Arguments = ('"{0}" "{1}" "{2}"' -f $qrHelper, $url, $qrImagePath)
  $startInfo.WorkingDirectory = $ProjectDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  $generator = New-Object System.Diagnostics.Process
  $generator.StartInfo = $startInfo
  [void]$generator.Start()
  $generator.WaitForExit()
  if ($generator.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $qrImagePath)) { return }

  $bytes = [System.IO.File]::ReadAllBytes($qrImagePath)
  $memory = New-Object System.IO.MemoryStream(,$bytes)
  try {
    $sourceImage = [System.Drawing.Image]::FromStream($memory)
    try { $newImage = New-Object System.Drawing.Bitmap($sourceImage) }
    finally { $sourceImage.Dispose() }
  } finally {
    $memory.Dispose()
  }

  if ($qrPicture.Image) { $qrPicture.Image.Dispose() }
  $qrPicture.Image = $newImage
  $script:lastQrUrl = $url
}

function Update-ServiceState {
  if ($script:isUpdating) { return }
  $script:isUpdating = $true
  try {
    $health = Get-LmdHealth
    $script:serviceRunning = $null -ne $health

    if ($script:serviceRunning) {
      $script:wasServiceRunning = $true
      $script:watchdogFailures = 0
      Set-TrayServiceIcon $true
      $addresses = @($health.lanAddresses)
      $script:primaryViewingUrl = if ($addresses.Count -gt 0) { [string]$addresses[0] } else { "" }
      $statusLabel.Text = "共享服务正在运行"
      $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(26, 127, 85)
      $statusDot.BackColor = [System.Drawing.Color]::FromArgb(38, 181, 119)
      $statusMenuItem.Text = "● 共享服务：运行中"
      $toggleButton.Text = "关闭共享服务"
      $toggleMenuItem.Text = "关闭共享服务"
      $toggleButton.BackColor = [System.Drawing.Color]::FromArgb(250, 238, 238)
      $toggleButton.ForeColor = [System.Drawing.Color]::FromArgb(174, 50, 50)
      $adminButton.Enabled = $true
      $openAdminMenuItem.Enabled = $true

      if ($script:primaryViewingUrl) {
        $viewingUrlBox.Text = $script:primaryViewingUrl
        $copyButton.Enabled = $true
        $qrHint.Text = "手机或平板扫描二维码打开观看端"
        Set-QrImage $script:primaryViewingUrl
      } else {
        $viewingUrlBox.Text = "暂未检测到局域网 IPv4 地址"
        $copyButton.Enabled = $false
        $qrHint.Text = "请检查这台电脑的网络连接"
        Clear-QrImage
      }
    } else {
      Set-TrayServiceIcon $false
      $script:primaryViewingUrl = ""
      $statusLabel.Text = "共享服务已停止（托盘仍在运行）"
      $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(145, 91, 28)
      $statusDot.BackColor = [System.Drawing.Color]::FromArgb(229, 157, 63)
      $statusMenuItem.Text = "● 共享服务：已停止"
      $toggleButton.Text = "启动共享服务"
      $toggleMenuItem.Text = "启动共享服务"
      $toggleButton.BackColor = [System.Drawing.Color]::FromArgb(28, 103, 196)
      $toggleButton.ForeColor = [System.Drawing.Color]::White
      $adminButton.Enabled = $false
      $openAdminMenuItem.Enabled = $false
      $viewingUrlBox.Text = "启动共享服务后显示观看地址"
      $copyButton.Enabled = $false
      $qrHint.Text = "点击下方按钮即可重新启动共享服务"
      Clear-QrImage
    }
  } finally {
    $script:isUpdating = $false
  }
}

function Start-SharingService([switch]$Quiet) {
  if (Get-LmdHealth) {
    Update-ServiceState
    return
  }

  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodeExecutable
    $startInfo.Arguments = ('"{0}"' -f $serverEntry)
    $startInfo.WorkingDirectory = $ProjectDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.EnvironmentVariables["UV_THREADPOOL_SIZE"] = [string]([Math]::Min(64, [Math]::Max(8, [Environment]::ProcessorCount * 2)))
    $serviceProcess = New-Object System.Diagnostics.Process
    $serviceProcess.StartInfo = $startInfo
    [void]$serviceProcess.Start()

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 180
      $health = Get-LmdHealth
    } while (-not $health -and [DateTime]::UtcNow -lt $deadline -and -not $serviceProcess.HasExited)

    Update-ServiceState
    if ($script:serviceRunning) {
      if (-not $Quiet) { Show-TrayMessage "LMD" "共享服务已启动。" }
    } else {
      if ($Quiet) {
        Show-TrayMessage "LMD" "自动重启共享服务失败，请检查 $port 端口是否被占用。" ([System.Windows.Forms.ToolTipIcon]::Warning)
      } else {
        [System.Windows.Forms.MessageBox]::Show("共享服务未能启动，请确认 $port 端口没有被其他程序占用。", "LMD 启动失败", "OK", "Error") | Out-Null
      }
    }
  } catch {
    if ($Quiet) {
      Show-TrayMessage "LMD" "自动重启共享服务失败：$($_.Exception.Message)" ([System.Windows.Forms.ToolTipIcon]::Warning)
      Update-ServiceState
    } else {
      [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "LMD 启动失败", "OK", "Error") | Out-Null
      Update-ServiceState
    }
  }
}

# 崩溃看门狗：服务曾经正常运行后意外退出时自动拉起。用户主动停止（manualStop）
# 或从未成功运行过、连续失败超过上限时不做自动重启。
function Invoke-ServiceWatchdog {
  if ($script:manualStop) { return }
  if (-not $script:wasServiceRunning) { return }
  if ($script:watchdogFailures -ge 3) { return }
  if ($script:serviceRunning) { return }
  $script:watchdogFailures += 1
  Show-TrayMessage "LMD" "检测到共享服务意外退出，正在自动重启…" ([System.Windows.Forms.ToolTipIcon]::Warning)
  Start-SharingService -Quiet
}

function Stop-SharingService {
  if (-not (Get-LmdHealth)) {
    $script:manualStop = $true
    Update-ServiceState
    return
  }

  try {
    Invoke-RestMethod -Uri $stopUrl -Method Post -TimeoutSec 3 | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    do {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 160
      $health = Get-LmdHealth
    } while ($health -and [DateTime]::UtcNow -lt $deadline)

    Update-ServiceState
    if (-not $script:serviceRunning) {
      $script:manualStop = $true
      Show-TrayMessage "LMD" "共享服务已关闭，系统托盘会继续运行。"
    } else {
      [System.Windows.Forms.MessageBox]::Show("共享服务没有在预期时间内停止，请稍后重试。", "LMD", "OK", "Warning") | Out-Null
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "无法关闭共享服务", "OK", "Error") | Out-Null
    Update-ServiceState
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "LMD 系统托盘"
$form.ClientSize = New-Object System.Drawing.Size(460, 625)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 252)
$form.Font = New-UiFont 9

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Location = New-Object System.Drawing.Point(28, 24)
$titleLabel.Size = New-Object System.Drawing.Size(400, 35)
$titleLabel.Text = "LMD 局域网视频共享"
$titleLabel.Font = New-UiFont 18 ([System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(20, 35, 60)
$form.Controls.Add($titleLabel)

$statusDot = New-Object System.Windows.Forms.Panel
$statusDot.Location = New-Object System.Drawing.Point(31, 69)
$statusDot.Size = New-Object System.Drawing.Size(11, 11)
$form.Controls.Add($statusDot)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(51, 64)
$statusLabel.Size = New-Object System.Drawing.Size(370, 24)
$statusLabel.Font = New-UiFont 9.5 ([System.Drawing.FontStyle]::Bold)
$form.Controls.Add($statusLabel)

$adminButton = New-Object System.Windows.Forms.Button
$adminButton.Location = New-Object System.Drawing.Point(28, 102)
$adminButton.Size = New-Object System.Drawing.Size(404, 46)
$adminButton.Text = "打开本机管理网页"
$adminButton.Font = New-UiFont 10 ([System.Drawing.FontStyle]::Bold)
$adminButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$adminButton.FlatAppearance.BorderSize = 0
$adminButton.BackColor = [System.Drawing.Color]::FromArgb(28, 103, 196)
$adminButton.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($adminButton)

$qrCard = New-Object System.Windows.Forms.Panel
$qrCard.Location = New-Object System.Drawing.Point(28, 164)
$qrCard.Size = New-Object System.Drawing.Size(404, 343)
$qrCard.BackColor = [System.Drawing.Color]::White
$qrCard.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($qrCard)

$qrTitle = New-Object System.Windows.Forms.Label
$qrTitle.Location = New-Object System.Drawing.Point(18, 15)
$qrTitle.Size = New-Object System.Drawing.Size(365, 26)
$qrTitle.Text = "观看端二维码"
$qrTitle.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$qrTitle.Font = New-UiFont 11 ([System.Drawing.FontStyle]::Bold)
$qrTitle.ForeColor = [System.Drawing.Color]::FromArgb(20, 35, 60)
$qrCard.Controls.Add($qrTitle)

$qrPicture = New-Object System.Windows.Forms.PictureBox
$qrPicture.Location = New-Object System.Drawing.Point(72, 47)
$qrPicture.Size = New-Object System.Drawing.Size(258, 238)
$qrPicture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
$qrPicture.BackColor = [System.Drawing.Color]::White
$qrCard.Controls.Add($qrPicture)

$qrHint = New-Object System.Windows.Forms.Label
$qrHint.Location = New-Object System.Drawing.Point(18, 294)
$qrHint.Size = New-Object System.Drawing.Size(365, 30)
$qrHint.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$qrHint.ForeColor = [System.Drawing.Color]::FromArgb(93, 105, 124)
$qrCard.Controls.Add($qrHint)

$viewingUrlBox = New-Object System.Windows.Forms.TextBox
$viewingUrlBox.Location = New-Object System.Drawing.Point(28, 522)
$viewingUrlBox.Size = New-Object System.Drawing.Size(306, 28)
$viewingUrlBox.ReadOnly = $true
$viewingUrlBox.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($viewingUrlBox)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Location = New-Object System.Drawing.Point(342, 519)
$copyButton.Size = New-Object System.Drawing.Size(90, 31)
$copyButton.Text = "复制地址"
$copyButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$copyButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(198, 207, 221)
$copyButton.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($copyButton)

$toggleButton = New-Object System.Windows.Forms.Button
$toggleButton.Location = New-Object System.Drawing.Point(28, 566)
$toggleButton.Size = New-Object System.Drawing.Size(278, 42)
$toggleButton.Font = New-UiFont 10 ([System.Drawing.FontStyle]::Bold)
$toggleButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$toggleButton.FlatAppearance.BorderSize = 0
$form.Controls.Add($toggleButton)

$hideButton = New-Object System.Windows.Forms.Button
$hideButton.Location = New-Object System.Drawing.Point(314, 566)
$hideButton.Size = New-Object System.Drawing.Size(118, 42)
$hideButton.Text = "隐藏到托盘"
$hideButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$hideButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(198, 207, 221)
$hideButton.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($hideButton)

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$statusMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusMenuItem.Enabled = $false
$openPanelMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开控制面板与二维码")
$openAdminMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开本机管理网页")
$toggleMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("退出托盘（共享服务继续）")
[void]$contextMenu.Items.Add($statusMenuItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($openPanelMenuItem)
[void]$contextMenu.Items.Add($openAdminMenuItem)
[void]$contextMenu.Items.Add($toggleMenuItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($exitMenuItem)

function Import-LmdTrayIcon([string]$path) {
  if (Test-Path -LiteralPath $path) {
    try { return New-Object System.Drawing.Icon($path) }
    catch { }
  }
  return [System.Drawing.Icon][System.Drawing.SystemIcons]::Application.Clone()
}

$runningTrayIcon = Import-LmdTrayIcon $runningTrayIconPath
$stoppedTrayIcon = Import-LmdTrayIcon $stoppedTrayIconPath

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $stoppedTrayIcon
$notifyIcon.Text = "LMD 共享服务：正在检测"
$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Visible = $true
$form.Icon = $stoppedTrayIcon

function Show-ControlPanel {
  Write-TrayLog "show control panel requested"
  try {
    Update-ServiceState
    $form.ShowInTaskbar = $true
    if (-not $form.Visible) { $form.Show() }
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    [void][LmdNativeWindow]::ShowWindow($form.Handle, 5)
    [void][LmdNativeWindow]::SetForegroundWindow($form.Handle)
    $form.Activate()
    $form.BringToFront()
    Write-TrayLog ("control panel shown; visible={0}; handle={1}" -f $form.Visible, $form.Handle)
  } catch {
    Write-TrayLog ("show control panel failed: {0}" -f $_.Exception.ToString())
    Show-TrayMessage "LMD" "无法打开托盘控制面板，请重新启动 LMD。" ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
}

function Open-AdminPage {
  if (-not $script:serviceRunning) { return }
  Start-Process -FilePath $adminUrl
}

function Exit-Tray {
  $script:allowFormClose = $true
  $notifyIcon.Visible = $false
  $form.Close()
  [System.Windows.Forms.Application]::ExitThread()
}

$notifyIcon.Add_MouseClick({
  param($sender, $eventArgs)
  if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-ControlPanel }
})
$notifyIcon.Add_DoubleClick({ Open-AdminPage })
$form.Add_FormClosing({
  param($sender, $eventArgs)
  if (-not $script:allowFormClose -and $eventArgs.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) {
    $eventArgs.Cancel = $true
    $form.Hide()
  }
})
$adminButton.Add_Click({ Open-AdminPage })
$openAdminMenuItem.Add_Click({ Open-AdminPage })
$openPanelMenuItem.Add_Click({ Show-ControlPanel })
$toggleButton.Add_Click({ if ($script:serviceRunning) { Stop-SharingService } else { $script:manualStop = $false; Start-SharingService } })
$toggleMenuItem.Add_Click({ if ($script:serviceRunning) { Stop-SharingService } else { $script:manualStop = $false; Start-SharingService } })
$hideButton.Add_Click({ $form.Hide() })
$copyButton.Add_Click({
  if ($script:primaryViewingUrl) {
    [System.Windows.Forms.Clipboard]::SetText($script:primaryViewingUrl)
    Show-TrayMessage "LMD" "观看端地址已复制。"
  }
})
$exitMenuItem.Add_Click({ Exit-Tray })

$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 3000
$statusTimer.Add_Tick({
  Update-ServiceState
  Invoke-ServiceWatchdog
})
$statusTimer.Start()

$activationTimer = New-Object System.Windows.Forms.Timer
$activationTimer.Interval = 250
$activationTimer.Add_Tick({
  if ($activationEvent.WaitOne(0)) {
    Write-TrayLog "activation signal received"
    Show-ControlPanel
  }
})
$activationTimer.Start()

Start-SharingService
Update-ServiceState
if (-not $Autostart) { Show-ControlPanel }

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $statusTimer.Stop()
  $activationTimer.Stop()
  Clear-QrImage
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $runningTrayIcon.Dispose()
  $stoppedTrayIcon.Dispose()
  $contextMenu.Dispose()
  $form.Dispose()
  $activationEvent.Dispose()
  Remove-Item -LiteralPath $qrImagePath -Force -ErrorAction SilentlyContinue
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
