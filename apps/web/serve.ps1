# 启动前端静态服务器（脱离式，不随本命令退出）
# 用法：pwsh -File apps/web/serve.ps1 [-Port 8080] [-Target http://43.135.53.83:3000]

param(
  [int]$Port = 8080,
  [string]$Target = 'http://43.135.53.83:3000',
  [switch]$NoProxy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$devServer = Join-Path $PSScriptRoot 'dev-server.mjs'
$logDir = Join-Path $env:TEMP '2nkpoker-web'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "web-$Port.out.log"
$errLog = Join-Path $logDir "web-$Port.err.log"

# 找一个可用的 node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $bundled = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $bundled) { $node = $bundled }
}
if (-not $node) { throw '找不到 node，可执行文件不可用' }

# 已经在监听就直接返回
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "端口 $Port 已在监听（PID=$($existing[0].OwningProcess)），无需重启"
  exit 0
}

$args = @($devServer, '--port', "$Port")
if ($NoProxy) { $args += '--no-proxy' } else { $args += @('--target', $Target) }

$proc = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 2
if ($proc.HasExited) {
  Write-Host "启动失败，退出码 $($proc.ExitCode)"
  Write-Host '--- stderr ---'; Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -First 20
  exit 1
}

Write-Host "前端已启动：http://localhost:$Port  (PID=$($proc.Id))"
if ($NoProxy) { Write-Host '代理：已关闭（页面直连设置里的地址）' } else { Write-Host "代理目标：$Target" }
Write-Host "日志：$outLog"
Write-Host "停止：Stop-Process -Id $($proc.Id)"
