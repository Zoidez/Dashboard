<#
Creates Build\Dashboard.lnk -> Build\app\Dashboard.exe (ARCHITECTURE.md, Storage). Run once after the
first packaged build, and again if the instance folder moves (a .lnk stores an absolute path).
Builds never create or change it. Writes only that one file.
  powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1 [-Instance <path to Build>]
#>
param([string]$Instance = (Join-Path (Split-Path -Parent $PSScriptRoot) "Build"))
$ErrorActionPreference = "Stop"
$inst = (Resolve-Path -LiteralPath $Instance).Path
$exe = Join-Path $inst "app\Dashboard.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "No packaged Dashboard at $exe; run npm run package first." }
$lnk = Join-Path $inst "Dashboard.lnk"
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $exe
$s.WorkingDirectory = Join-Path $inst "app"
$s.Description = "Dashboard"
$s.IconLocation = "$exe,0"
$s.Save()
Write-Host "Created $lnk"
