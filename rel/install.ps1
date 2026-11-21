# SPDX-License-Identifier: AGPL-3.0-only
#
# Installs Hildegard 0.1.0 for this Windows user: no admin rights, nothing outside %LOCALAPPDATA%\Hildegard.
#
#   irm https://github.com/baney75/hildegard/releases/download/v0.1.0/install.ps1 | iex
#
# What it does, in order:
#   1. Downloads Node.js 24.21.0 from nodejs.org and Hildegard 0.1.0 from GitHub, and checks each against the
#      SHA-256 written into this script. A file that doesn't match is refused and nothing is installed.
#   2. Puts them in %LOCALAPPDATA%\Hildegard, and a `hildegard` command in %LOCALAPPDATA%\Hildegard\bin, which it adds
#      to your user PATH.
#   3. Runs `hildegard install --yes`, which sets up ComfyUI and PyTorch for your GPU, then starts Hildegard.
#
# Set HILDEGARD_HOME to install somewhere else, HILDEGARD_SKIP_SETUP=1 to stop after step 2, or
# HILDEGARD_INSTALL_ARGS (for example "--json") to pass options to step 3.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Version = '0.1.0'
$Node = '24.21.0'
$Release = if ($env:HILDEGARD_RELEASE_URL) { $env:HILDEGARD_RELEASE_URL } else { "https://github.com/baney75/hildegard/releases/download/v$Version" }
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$AppSha = @{ 'x64' = 'a9168c257961e1e381946d4dd1c25fc26aca28af3a776f8074b68f8cfbb7736f'; 'arm64' = 'ad1aa9fe2d8f14a21aed8500dd23b75fbed5441ff450fcc8e44d89f97b95c441' }
$NodeSha = @{ 'x64' = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'; 'arm64' = '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' }

$Root = if ($env:HILDEGARD_HOME) { $env:HILDEGARD_HOME } else { Join-Path $env:LOCALAPPDATA 'Hildegard' }
$Bin = Join-Path $Root 'bin'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hildegard-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Root, $Bin, $Tmp | Out-Null

function Get-Checked([string]$Url, [string]$Path, [string]$Sha) {
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
  $got = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
  if ($got -ne $Sha) {
    Remove-Item -Force $Path
    throw "$(Split-Path -Leaf $Path) didn't match its checksum (expected $Sha, got $got). Nothing was installed."
  }
}

try {
  # Node.js, Hildegard's own copy, so it never depends on (or changes) one you have.
  $nodeExe = Join-Path $Root 'node\node.exe'
  $have = if (Test-Path $nodeExe) { & $nodeExe --version } else { '' }
  if ($have -ne "v$Node") {
    Write-Host "Getting Node.js $Node..."
    $f = "node-v$Node-win-$Arch.zip"
    Get-Checked "https://nodejs.org/dist/v$Node/$f" (Join-Path $Tmp $f) $NodeSha[$Arch]
    Expand-Archive -Path (Join-Path $Tmp $f) -DestinationPath $Tmp -Force
    $dest = Join-Path $Root 'node'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item (Join-Path $Tmp "node-v$Node-win-$Arch") $dest
  }

  Write-Host "Getting Hildegard $Version..."
  $f = "hildegard-$Version-win32-$Arch.tar.gz"
  Get-Checked "$Release/$f" (Join-Path $Tmp $f) $AppSha[$Arch]
  $app = Join-Path $Root "app-$Version"
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf (Join-Path $Tmp $f) -C $app --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $f." }

  # `app` is a junction to the current version (no admin rights needed), so paths given to AI apps survive upgrades.
  # Keep this version and the one before it, for going back.
  $link = Join-Path $Root 'app'
  $prev = if (Test-Path $link) { Split-Path -Leaf (Get-Item $link).Target } else { '' }
  if (Test-Path $link) { (Get-Item $link).Delete() }
  New-Item -ItemType Junction -Path $link -Target $app | Out-Null
  Get-ChildItem -Directory -Path $Root -Filter 'app-*' | Where-Object { $_.Name -ne "app-$Version" -and $_.Name -ne $prev } | Remove-Item -Recurse -Force

  $launcher = Join-Path $Bin 'hildegard.cmd'
  Set-Content -Path $launcher -Encoding ASCII -Value @"
@echo off
set "HILDEGARD_HOME=$Root"
set "HILDEGARD_ENTRY=$link\hildegard.mjs"
"$Root\node\node.exe" "$link\hildegard.mjs" %*
"@
  Write-Host "Installed the hildegard command in $Bin."

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $Bin)) {
    [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $Bin) | Where-Object { $_ }) -join ';'), 'User')
    Write-Host "Added $Bin to your PATH. New terminals will find hildegard by name."
  }
  if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

if ($env:HILDEGARD_SKIP_SETUP -ne '1') {
  $extra = if ($env:HILDEGARD_INSTALL_ARGS) { $env:HILDEGARD_INSTALL_ARGS -split '\s+' | Where-Object { $_ } } else { @() }
  & $launcher install --yes @extra
  # A throw, not exit: under `irm | iex`, exit would close the window.
  if ($LASTEXITCODE -ne 0) { throw "hildegard install didn't finish. Run it again with: hildegard install" }
}
