<#
.SYNOPSIS
  Builds and starts the development / LASS container and its egress proxy, then checks the walls
  (docs/INFRASTRUCTURE.md). A developer convenience script: the Dashboard itself will start these
  only through its container backend (rule O1, D3).

.DESCRIPTION
  1. Builds infra/images/egress-proxy and infra/images/lass-dev, tagged with the git commit (I1).
  2. Creates the internal network lass-internal (--internal: no route out) if missing.
  3. Starts the proxy pod (lass-internal + the outside network) and the dev pod (lass-internal only)
     with podman kube play, from infra/k8s/*.yaml and infra/proxy/allowlist.yaml.
  4. Checks, each recorded PASS/FAIL/INFO:
     the dev container runs under gVisor as user 10001 with a read-only root; Claude Code is installed;
     an allowed host is reached through the proxy, a host not on the list is refused, and nothing is
     reached without the proxy; no Windows drive and no Podman socket inside; the proxy logs requests.
  -AfterLogin: after the user signed in once (Build\data\podman\podman.cmd exec -it lass-dev-main claude), runs one prompt
  through the proxy and lists what the proxy refused (open item 4).
  -Down removes both pods (the login volume stays).
#>
param([switch]$AfterLogin, [switch]$Down)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$repoRoot  = Split-Path -Parent $PSScriptRoot
$podmanDir = Join-Path $repoRoot "Build\data\podman"
. (Join-Path $podmanDir "env.ps1")
$outDir = Join-Path $podmanDir "lass"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$logFile = Join-Path $outDir ("lass-dev-" + (Get-Date).ToString("yyyyMMdd-HHmmss") + ".log")

function Log([string]$s) { Add-Content -LiteralPath $logFile -Value $s -Encoding UTF8 }
function Record([string]$id, [string]$what, [string]$outcome, [string]$detail = "") {
  Write-Host ("{0,-4} {1,-4} {2}" -f $outcome, $id, $what) -ForegroundColor (@{ PASS = "Green"; FAIL = "Red"; INFO = "Gray" }[$outcome])
  if ($detail) { Write-Host "          $($detail -replace "`n", "`n          ")" }
  Log "[$outcome] $id $what`n$detail`n"
}
function Pm([string[]]$a) {
  Log "> podman $($a -join ' ')"
  $out = & podman @a 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE; $text = ($out -join "`n").Trim()
  Log "$text`n(exit $code)`n"
  return @{ code = $code; out = $text }
}
# The script goes in base64: Windows PowerShell 5.1 mangles quotes in arguments to native programs.
function InDev([string]$s) { $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s.Replace("`r", ""))); return Pm @("exec", "lass-dev-main", "sh", "-c", "echo $b | base64 -d | sh") }
# A refusal only counts when the container exists and the command ran.
function Ran($r) { return $r.out -notmatch "no container with name or ID|Error: |not found" }

$egressYaml = Join-Path $repoRoot "infra\k8s\lass-egress.yaml"
$devYaml    = Join-Path $repoRoot "infra\k8s\lass-dev.yaml"
$allowlist  = Join-Path $repoRoot "infra\proxy\allowlist.yaml"
$rendered   = @{ egress = Join-Path $outDir "lass-egress.yaml"; dev = Join-Path $outDir "lass-dev.yaml" }

if ($Down) {
  foreach ($f in $rendered.Values) { if (Test-Path $f) { [void](Pm @("kube", "down", $f)) } }
  Write-Host "Both pods removed; the login volume lass-claude-config stays."; exit
}

if ($AfterLogin) {
  $r = InDev 'cd /tmp && timeout 120 claude -p "Reply with exactly: OK" 2>&1 | tail -5'
  Record "L1" "Claude Code answers through the egress proxy" $(if ($r.out -match "\bOK\b") { "PASS" } else { "FAIL" }) $r.out
  $denied = Pm @("logs", "lass-egress-proxy")
  $lines = @($denied.out -split "`n" | Where-Object { $_ -match "TCP_DENIED" } | ForEach-Object { ($_ -split "\s+")[6] } | Sort-Object -Unique)
  Record "L2" "Hosts the proxy refused during sign-in and use" "INFO" ($(if ($lines.Count) { $lines -join "`n" } else { "none" }))
  exit
}

# ---------- 1. images ----------
$commit = (git -C $repoRoot rev-parse --short=12 HEAD).Trim()
$dirty = (git -C $repoRoot status --porcelain -- infra).Length -gt 0
$tag = if ($dirty) { "$commit-dirty" } else { $commit }
$images = @{}
foreach ($n in "egress-proxy", "lass-dev") {
  $ref = "localhost/dashboard-${n}:$tag"
  # Build steps run under the machine user's default runtime, gVisor (runsc-rootless drops the builder's
  # crun-only flag); the remote client has no --runtime option for builds.
  $b = Pm @("build", "--no-cache", "-t", $ref, (Join-Path $repoRoot "infra\images\$n"))
  $id = (Pm @("image", "inspect", $ref, "--format", "{{.Id}}")).out
  Record "B$($images.Count + 1)" "Image $ref" $(if ($b.code -eq 0) { "PASS" } else { "FAIL" }) $(if ($b.code -eq 0) { "id $id" } else { ($b.out -split "`n" | Select-Object -Last 15) -join "`n" })
  $images[$n] = $ref
}
if ($dirty) { Record "B0" "infra/ has uncommitted changes: images tagged -dirty" "INFO" }

# ---------- 2. network ----------
$net = Pm @("network", "inspect", "lass-internal", "--format", "{{.Internal}} {{.DNSEnabled}}")
if ($net.code -ne 0) { [void](Pm @("network", "create", "--internal", "lass-internal")); $net = Pm @("network", "inspect", "lass-internal", "--format", "{{.Internal}} {{.DNSEnabled}}") }
Record "N1" "Network lass-internal is internal, with DNS" $(if ($net.out -eq "true true") { "PASS" } else { "FAIL" }) "internal, dns: $($net.out)"
# The proxy's way out: a normal network with its own DNS (which forwards outside names), on a fixed
# subnet so squid.conf can name that DNS server (dns_nameservers 10.89.250.1).
$eg = Pm @("network", "inspect", "egress", "--format", "{{.Internal}} {{.DNSEnabled}} {{range .Subnets}}{{.Subnet}}{{end}}")
if ($eg.code -ne 0) { [void](Pm @("network", "create", "--subnet", "10.89.250.0/24", "egress")); $eg = Pm @("network", "inspect", "egress", "--format", "{{.Internal}} {{.DNSEnabled}} {{range .Subnets}}{{.Subnet}}{{end}}") }
Record "N2" "Network egress: outside, with DNS, subnet 10.89.250.0/24" $(if ($eg.out -eq "false true 10.89.250.0/24") { "PASS" } else { "FAIL" }) $eg.out

# ---------- 3. pods ----------
[IO.File]::WriteAllText($rendered.egress, ((Get-Content -Raw $egressYaml).Replace("{{IMAGE}}", $images["egress-proxy"])).Replace("`r", ""), (New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText($rendered.dev, ((Get-Content -Raw $devYaml).Replace("{{IMAGE}}", $images["lass-dev"])).Replace("`r", ""), (New-Object Text.UTF8Encoding $false))
foreach ($f in $rendered.Values) { [void](Pm @("kube", "down", $f)) }
$p1 = Pm @("kube", "play", "--network", "lass-internal", "--network", "egress", "--configmap", $allowlist, $rendered.egress)
Record "P1" "Egress proxy pod starts" $(if ($p1.code -eq 0) { "PASS" } else { "FAIL" }) $(if ($p1.code -ne 0) { $p1.out })
$p2 = Pm @("kube", "play", "--network", "lass-internal", $rendered.dev)
Record "P2" "Dev pod starts" $(if ($p2.code -eq 0) { "PASS" } else { "FAIL" }) $(if ($p2.code -ne 0) { $p2.out })
Start-Sleep -Seconds 4

# ---------- 4. walls ----------
$who = InDev 'uname -r; id -u; touch /x 2>&1 || echo ro-root'
Record "D1" "Dev container: gVisor, user 10001, read-only root" $(if ($who.out -match "gvisor" -and $who.out -match "(^|\n)10001(\n|$)" -and $who.out -match "ro-root|Read-only") { "PASS" } else { "FAIL" }) $who.out
$v = InDev 'claude --version 2>&1 | head -1'
Record "D2" "Claude Code installed" $(if ($v.out -match "2\.1\.296") { "PASS" } else { "FAIL" }) $v.out
$ok = InDev 'curl -sS -o /dev/null -w "%{http_code}" --max-time 15 https://api.anthropic.com/ 2>&1'
Record "D3" "Allowed host reached through the proxy (api.anthropic.com)" $(if ($ok.out -match "^\d{3}$" -and $ok.out -ne "000") { "PASS" } else { "FAIL" }) "HTTP $($ok.out)"
$no = InDev 'curl -sS -o /dev/null -w "%{http_code}" --max-time 15 https://example.com/ 2>&1; echo " exit=$?"'
Record "D4" "Host not on the list refused by the proxy (example.com)" $(if ($no.out -match "403|CONNECT tunnel failed") { "PASS" } else { "FAIL" }) $no.out
$direct = InDev 'curl -sS -o /dev/null -w "%{http_code}" --max-time 10 --noproxy "*" https://api.anthropic.com/ 2>&1; echo " exit=$?"'
Record "D5" "Nothing reached without the proxy (no route out)" $(if ((Ran $direct) -and $direct.out -notmatch "^(2|3|4)\d\d ") { "PASS" } else { "FAIL" }) $direct.out
$host_ = InDev '# gVisor serves every mount over 9p itself; Windows drives would show as drvfs or under /mnt.
mount | grep -Ei "drvfs|aname=[A-Za-z]:|/mnt/[a-z] " || echo no-windows-mounts; ls /run/podman/podman.sock /var/run/docker.sock 2>&1 | head -2'
Record "D6" "No Windows drive and no Podman socket inside" $(if ((Ran $host_) -and $host_.out -match "no-windows-mounts" -and $host_.out -notmatch "srw") { "PASS" } else { "FAIL" }) $host_.out
$plog = Pm @("logs", "--tail", "20", "lass-egress-proxy")
Record "D7" "The proxy logs requests (allowed and denied)" $(if ($plog.out -match "TCP_TUNNEL|TCP_DENIED") { "PASS" } else { "FAIL" }) (($plog.out -split "`n" | Where-Object { $_ -match "TCP_" } | Select-Object -Last 6) -join "`n")

Write-Host "`nLog: $logFile"
Write-Host "Next (the user, once): sign in inside the container, then run this script with -AfterLogin:"
Write-Host "  & `"$podmanDir\podman.cmd`" exec -it lass-dev-main claude"
