<#
.SYNOPSIS
  Installs the Podman client for Windows as a portable copy inside the Dashboard instance.

.DESCRIPTION
  Where things go (all under Build\, never the user profile):
    Build\data\vendor\podman\<version>\   podman.exe and its helpers (gvproxy.exe, win-sshproxy.exe)
    Build\data\vendor\podman\install.json version and SHA-256 of what was installed
    Build\data\podman\                    Podman's config and data (machine disk, images), via env.ps1
    Build\data\podman\env.ps1             dot-source this before using podman by hand

  What it does NOT do:
    - no administrator rights needed, no change to PATH, registry or Windows features
    - does not run "podman machine init" (the verification step observes that from a clean state)
    - does not install WSL (that is: wsl.exe --install --no-distribution, run separately as admin)

  The download is checked against the SHA-256 list published with the same GitHub release.
  That catches a broken or swapped download, not a compromised release.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\install-podman.ps1
  powershell -ExecutionPolicy Bypass -File setup\install-podman.ps1 -Version 5.6.2
#>
param(
  [string]$Version = ""   # empty = the latest stable release
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times slower with the progress bar

$repoRoot  = Split-Path -Parent $PSScriptRoot
$build     = Join-Path $repoRoot "Build"
$vendorDir = Join-Path $build "data\vendor\podman"
$podmanDir = Join-Path $build "data\podman"
$dlDir     = Join-Path $podmanDir "_download"
if (-not (Test-Path -LiteralPath $build)) { throw "No Build folder at $build. Run this from the Dashboard repository." }

# 1. Which release
$api = "https://api.github.com/repos/containers/podman/releases"
$rel = if ($Version) { Invoke-RestMethod "$api/tags/v$($Version.TrimStart('v'))" } else { Invoke-RestMethod "$api/latest" }
$Version = $rel.tag_name.TrimStart("v")
if ($rel.prerelease) { throw "v$Version is a pre-release; pass a stable -Version." }
Write-Host "Podman v$Version"

$target = Join-Path $vendorDir $Version
if (Test-Path -LiteralPath (Join-Path $target "podman.exe")) { Write-Host "Already installed: $target"; exit 0 }

$zipAsset  = $rel.assets | Where-Object { $_.name -eq "podman-remote-release-windows_amd64.zip" }
$sumsAsset = $rel.assets | Where-Object { $_.name -eq "shasums" }
if (-not $zipAsset -or -not $sumsAsset) {
  throw "Release v$Version has no podman-remote-release-windows_amd64.zip or no shasums file. Assets: $(($rel.assets.name) -join ', ')"
}

# 2. Download and verify
New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
$zip  = Join-Path $dlDir $zipAsset.name
$sums = Join-Path $dlDir "shasums"
Write-Host "Downloading $($zipAsset.name) ($([math]::Round($zipAsset.size / 1MB, 1)) MB)"
Invoke-WebRequest -UseBasicParsing -Uri $zipAsset.browser_download_url -OutFile $zip
Invoke-WebRequest -UseBasicParsing -Uri $sumsAsset.browser_download_url -OutFile $sums

$line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "\s\*?$([regex]::Escape($zipAsset.name))$" } | Select-Object -First 1
if (-not $line) { throw "shasums has no entry for $($zipAsset.name)" }
$expected = ($line -split "\s+")[0].ToLower()
$actual   = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA-256 mismatch for $($zipAsset.name): expected $expected, got $actual" }
Write-Host "SHA-256 OK: $actual"

# 3. Extract into a fresh folder, then move the bin folder into place
$x = Join-Path $dlDir "x"
if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $x
$exe = Get-ChildItem -LiteralPath $x -Recurse -Filter "podman.exe" | Select-Object -First 1
if (-not $exe) { throw "podman.exe not found in the archive" }
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
Move-Item -LiteralPath $exe.Directory.FullName -Destination $target
foreach ($h in "gvproxy.exe", "win-sshproxy.exe") {
  if (-not (Test-Path -LiteralPath (Join-Path $target $h))) { Write-Warning "$h is not next to podman.exe; podman machine may not start." }
}

# 4. Record what was installed
$record = [ordered]@{
  version    = $Version
  installed  = (Get-Date).ToUniversalTime().ToString("o")
  source     = $zipAsset.browser_download_url
  zipSha256  = $actual
  files      = @(Get-ChildItem -LiteralPath $target -File | ForEach-Object {
                 [ordered]@{ name = $_.Name; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower() } })
}
[IO.File]::WriteAllText((Join-Path $vendorDir "install.json"), (ConvertTo-Json -InputObject $record -Depth 5))

# 5. Podman's own folders under Build\data\podman, and env.ps1 that points Podman at them
foreach ($d in "config", "data") { New-Item -ItemType Directory -Force -Path (Join-Path $podmanDir $d) | Out-Null }
$conf = Join-Path $podmanDir "containers.conf"
if (-not (Test-Path -LiteralPath $conf)) {
  $helpers = $target.Replace("\", "\\")
  [IO.File]::WriteAllText($conf, "[engine]`nhelper_binaries_dir = [`"$helpers`"]`n`n[machine]`nprovider = `"wsl`"`n")
}
$envPs1 = @"
# Dot-source before using podman by hand:  . "$podmanDir\env.ps1"
# Points Podman's config and data at Build\data\podman instead of the user profile. Written by setup\install-podman.ps1.
`$env:XDG_CONFIG_HOME = "$podmanDir\config"
`$env:XDG_DATA_HOME   = "$podmanDir\data"
`$env:CONTAINERS_CONF = "$conf"
`$env:CONTAINERS_MACHINE_PROVIDER = "wsl"
`$env:PATH = "$target;" + `$env:PATH
"@
[IO.File]::WriteAllText((Join-Path $podmanDir "env.ps1"), $envPs1)

Remove-Item -LiteralPath $dlDir -Recurse -Force
& (Join-Path $target "podman.exe") --version
Write-Host "Installed to $target"
Write-Host "Do not run 'podman machine init' yet: the verification script does that and checks where the files land."
