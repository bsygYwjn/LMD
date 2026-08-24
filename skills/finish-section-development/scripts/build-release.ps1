[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^V\d+\.\d+_Beta$')]
  [string]$Version,

  [Parameter()]
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path,

  [Parameter()]
  [string]$OutputRoot = 'C:\Users\dytdy\Desktop\LMD发布版'
)

$ErrorActionPreference = 'Stop'

$projectRootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$outputRootFull = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$releaseName = "LMD_$Version"
$releaseDirectory = [System.IO.Path]::GetFullPath((Join-Path $outputRootFull $releaseName))
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $outputRootFull "$releaseName.zip"))
$outputPrefix = $outputRootFull + [System.IO.Path]::DirectorySeparatorChar

if (-not $releaseDirectory.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "发布目录越出了指定发布根目录：$releaseDirectory"
}
if (Test-Path -LiteralPath $releaseDirectory) { throw "发布目录已经存在，不会覆盖：$releaseDirectory" }
if (Test-Path -LiteralPath $archivePath) { throw "发布压缩包已经存在，不会覆盖：$archivePath" }

$versionMatch = [regex]::Match($Version, '^V(?<major>\d+)\.(?<minor>\d+)_Beta$')
$expectedPackageVersion = "$($versionMatch.Groups['major'].Value).$($versionMatch.Groups['minor'].Value).0-beta"
$packagePath = Join-Path $projectRootFull 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8 | ConvertFrom-Json
if ($package.version -ne $expectedPackageVersion) {
  throw "package.json 版本为 $($package.version)，期望 $expectedPackageVersion。"
}

$requiredDirectories = @('assets', 'dist', 'runtime', 'server', 'tools')
$requiredFiles = @('启动LMD.vbs', 'LMD使用说明.md', 'README.md', 'package.json', 'pnpm-lock.yaml', 'tray-qr.mjs', 'tray.ps1')
foreach ($relativePath in @($requiredDirectories + $requiredFiles)) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRootFull $relativePath))) {
    throw "发布所需文件不存在：$relativePath"
  }
}

New-Item -ItemType Directory -Path $outputRootFull -Force | Out-Null

try {
  New-Item -ItemType Directory -Path $releaseDirectory | Out-Null

  foreach ($directory in $requiredDirectories) {
    Copy-Item -LiteralPath (Join-Path $projectRootFull $directory) -Destination (Join-Path $releaseDirectory $directory) -Recurse -Force
  }
  foreach ($file in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRootFull $file) -Destination (Join-Path $releaseDirectory $file) -Force
  }

  $pnpmCommand = Get-Command pnpm.cmd -ErrorAction Stop
  $pnpmStore = (Resolve-Path -LiteralPath (Join-Path $projectRootFull '.pnpm-store')).Path
  $previousCi = $env:CI
  try {
    $env:CI = 'true'
    Push-Location -LiteralPath $releaseDirectory
    & $pnpmCommand.Source install --prod --offline --frozen-lockfile --ignore-scripts --store-dir $pnpmStore --config.node-linker=hoisted
    if ($LASTEXITCODE -ne 0) { throw "安装发布版运行依赖失败，pnpm 返回 $LASTEXITCODE。" }
  }
  finally {
    Pop-Location
    $env:CI = $previousCi
  }

  foreach ($cachePath in @('data\cache\fonts', 'data\cache\subtitles', 'data\cache\thumbnails', 'data\cache\music-covers', 'data\cache\music-lyrics')) {
    New-Item -ItemType Directory -Path (Join-Path $releaseDirectory $cachePath) -Force | Out-Null
  }

  $commit = (& git -C $projectRootFull rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw '无法读取当前 Git 提交。' }
  [ordered]@{
    name = 'LMD'
    release = $Version
    packageVersion = $package.version
    commit = $commit
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseDirectory 'release-manifest.json') -Encoding utf8

  & tar.exe -a -c -f $archivePath -C $outputRootFull $releaseName
  if ($LASTEXITCODE -ne 0) { throw "创建 ZIP 失败，tar.exe 返回 $LASTEXITCODE。" }

  $archive = Get-Item -LiteralPath $archivePath
  $hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
  [pscustomobject]@{
    Version = $Version
    Directory = $releaseDirectory
    Archive = $archivePath
    Bytes = $archive.Length
    SHA256 = $hash.Hash
    Commit = $commit
  }
}
catch {
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  if (Test-Path -LiteralPath $releaseDirectory) { Remove-Item -LiteralPath $releaseDirectory -Recurse -Force }
  throw
}
