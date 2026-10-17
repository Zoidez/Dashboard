<#
.SYNOPSIS
  Second Podman check (docs/INFRASTRUCTURE.md, open item 5): the questions behind the decision
  "rootless + gVisor + no passwordless sudo" (user decision 2026-10-17, option A). Run after
  setup\verify-podman.ps1, on the machine it created.

.DESCRIPTION
  L  Whole-machine limits: does `podman machine init --cpus 2 --memory 2048` limit the WSL machine?
  R  Rootful gVisor: does a container run under gVisor as root, and is a 64 MB memory limit enforced?
     (a shell that tries to hold 150 MB must be killed). Plain rootful runc is the control.
  G  Option A set up: gVisor becomes the machine user's default runtime (a wrapper adds
     --ignore-cgroups), and a hardened Pod started with `podman kube play` runs under gVisor.
  S  Option A set up: the machine user loses passwordless sudo and the wheel group (backups kept),
     after root access over the machine's own root ssh connection was confirmed to work. Then:
     the user cannot sudo, cannot mount C:, rootless Podman with gVisor still works after a restart,
     and the root connection still works.

  -Restore puts sudo back (from the backups, over the root connection) and removes the default-runtime
  setting; nothing else. Results: Build\data\podman\verify\<time>-isolation\.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\verify-podman-isolation.ps1
#>
param([switch]$Restore)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$repoRoot  = Split-Path -Parent $PSScriptRoot
$podmanDir = Join-Path $repoRoot "Build\data\podman"
. (Join-Path $podmanDir "env.ps1")
if (-not $PodmanExe) { throw "Run setup\install-podman.ps1 -Version <installed version> first." }
$Machine = "dashboard"; $RootConn = "$Machine-root"; $Distro = "podman-$Machine"
$Image = "docker.io/library/alpine:3.20"
$outDir = Join-Path $podmanDir ("verify\" + (Get-Date).ToString("yyyyMMdd-HHmmss") + "-isolation")
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$logFile = Join-Path $outDir "log.txt"
$results = New-Object System.Collections.ArrayList

function Log([string]$s) { Add-Content -LiteralPath $logFile -Value $s -Encoding UTF8 }
function Record([string]$id, [string]$what, [string]$outcome, [string]$detail = "") {
  [void]$results.Add([ordered]@{ id = $id; check = $what; outcome = $outcome; detail = $detail })
  Write-Host ("{0,-4} {1,-4} {2}" -f $outcome, $id, $what) -ForegroundColor (@{ PASS = "Green"; FAIL = "Red"; INFO = "Gray" }[$outcome])
  if ($detail) { Write-Host "          $($detail -replace "`n", "`n          ")" }
  Log "[$outcome] $id $what`n$detail`n"
}
function Run([string]$exe, [string[]]$a) {
  Log "> $exe $($a -join ' ')"
  $out = & $exe @a 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE; $text = ($out -join "`n").Trim()
  Log "$text`n(exit $code)`n"
  return @{ code = $code; out = $text }
}
function Pm([string[]]$a) { return Run "podman" $a }
function PmRoot([string[]]$a) { return Run "podman" (@("--connection", $RootConn) + $a) }
function B64([string]$s) { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s.Replace("`r", ""))) }
function InVm([string]$s) { return Pm @("machine", "ssh", $Machine, "echo $(B64 $s) | base64 -d | sh") }
# Root inside the machine over Podman's own root ssh login, so nothing depends on the user's sudo.
function InVmRoot([string]$s) { return Pm @("machine", "ssh", "--username", "root", $Machine, "echo $(B64 $s) | base64 -d | sh") }
function Restart { [void](Pm @("machine", "stop", $Machine)); [void](Run "wsl.exe" @("--terminate", $Distro)); return Pm @("machine", "start", $Machine) }

$rootOk = (InVmRoot "id -u").out -match "(^|\n)0$"
if ($Restore) {
  if (-not $rootOk) { throw "root ssh into the machine does not work; cannot restore." }
  $r = InVmRoot 'for f in /etc/sudoers.d/*.dashboard-bak; do [ -e "$f" ] && mv "$f" "${f%.dashboard-bak}"; done; usermod -aG wheel user; rm -f /home/user/.config/containers/containers.conf.d/50-dashboard-gvisor.conf; ls -l /etc/sudoers.d; id user'
  Write-Host $r.out; exit
}

# ---------- L: whole-machine limits ----------
$hostCpu = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$hostMem = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$vm = InVm 'echo "cpus=$(nproc) memMB=$(awk "/MemTotal/{print int(\$2/1024)}" /proc/meminfo)"'
$cpus = [int]([regex]::Match($vm.out, "cpus=(\d+)").Groups[1].Value); $mem = [int]([regex]::Match($vm.out, "memMB=(\d+)").Groups[1].Value)
$limited = $cpus -le 2 -and $mem -le 2300
Record "L1" "podman machine init --cpus 2 --memory 2048 limits the WSL machine" $(if ($limited) { "PASS" } else { "FAIL" }) "inside: $cpus CPUs, $mem MB; this PC: $hostCpu CPUs, $hostMem MB. WSL takes machine limits from the user's global .wslconfig, not from Podman."

# ---------- R: rootful gVisor and memory limits ----------
[void](PmRoot @("pull", "-q", $Image)); [void](Pm @("pull", "-q", $Image))
$hog = 'x=$(head -c 150000000 /dev/zero | tr "\000" a); echo "held ${#x} bytes"'
$c1 = InVm "sudo -n podman run --rm --memory 64m $Image sh -c '$hog'; echo exit=`$?"
Record "R0" "Control: rootful runc kills a container above 64 MB" $(if ($c1.out -match "exit=(137|1)" -and $c1.out -notmatch "held 150000000") { "PASS" } else { "FAIL" }) $c1.out
$c2 = InVm "sudo -n podman --runtime /usr/local/bin/runsc run --rm --memory 64m $Image sh -c 'uname -r; $hog'; echo exit=`$?"
$gv = $c2.out -match "gvisor"
$killed = $c2.out -notmatch "held 150000000"
Record "R1" "Rootful gVisor runs" $(if ($gv) { "PASS" } else { "FAIL" }) $c2.out
Record "R2" "Rootful gVisor enforces the 64 MB limit" $(if ($gv -and $killed) { "PASS" } else { "FAIL" }) $c2.out

# ---------- G: gVisor as the user's default runtime (option A) ----------
$setup = @'
set -e
mkdir -p /home/user/.config/containers/containers.conf.d
cat > /home/user/.config/containers/containers.conf.d/50-dashboard-gvisor.conf <<'EOF'
# Dashboard (INFRASTRUCTURE.md, X1, option A): every rootless container runs under gVisor.
# Rootless gVisor cannot use cgroups in Podman's WSL machine, hence the wrapper with --ignore-cgroups.
[engine]
runtime = "runsc-rootless"
[engine.runtimes]
runsc-rootless = ["/usr/local/bin/runsc-rootless"]
EOF
cat /home/user/.config/containers/containers.conf.d/50-dashboard-gvisor.conf
'@
$wrapper = 'printf "#!/bin/sh\nexec /usr/local/bin/runsc --ignore-cgroups \"\$@\"\n" > /usr/local/bin/runsc-rootless; chmod 755 /usr/local/bin/runsc-rootless; cat /usr/local/bin/runsc-rootless'
$w = InVmRoot $wrapper
$s = InVm $setup
Record "G1" "gVisor (with --ignore-cgroups) set as the machine user's default runtime" $(if ($w.code -eq 0 -and $s.code -eq 0) { "INFO" } else { "FAIL" }) "$($w.out)`n$($s.out)"
$pod = @"
apiVersion: v1
kind: Pod
metadata: { name: verify-gvisor }
spec:
  containers:
    - name: main
      image: $Image
      command: ["sh", "-c", "uname -r; sleep 3600"]
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
"@
$yaml = Join-Path $outDir "gvisor-pod.yaml"
[IO.File]::WriteAllText($yaml, $pod.Replace("`r", ""), (New-Object Text.UTF8Encoding $false))
function GvisorPod([string]$id, [string]$what) {
  $p = Pm @("kube", "play", $yaml)
  Start-Sleep -Seconds 3
  $l = Pm @("logs", "verify-gvisor-main")
  $rt = Pm @("inspect", "verify-gvisor-main", "--format", "{{.OCIRuntime}}")
  Record $id $what $(if ($p.code -eq 0 -and $l.out -match "gvisor") { "PASS" } else { "FAIL" }) "$($p.out)`nkernel inside: $($l.out)`nruntime: $($rt.out)"
  [void](Pm @("kube", "down", $yaml))
}
GvisorPod "G2" "Hardened Pod from kube play runs under gVisor, rootless"

# ---------- S: no passwordless sudo for the machine user (option A) ----------
Record "S1" "Root over the machine's own root ssh login works (needed before sudo goes)" $(if ($rootOk) { "PASS" } else { "FAIL" })
if ($rootOk) {
  $before = InVmRoot 'grep -rn "NOPASSWD\|^%wheel\|^user" /etc/sudoers /etc/sudoers.d 2>/dev/null; id user'
  Record "S2" "Where the user's sudo comes from" "INFO" $before.out
  $strip = @'
for f in /etc/sudoers.d/*; do
  case "$f" in *.dashboard-bak) continue;; esac
  if grep -qE "^(user|%wheel)[[:space:]].*NOPASSWD" "$f"; then mv "$f" "$f.dashboard-bak"; echo "moved aside: $f"; fi
done
gpasswd -d user wheel 2>&1 || true
id user
'@
  $x = InVmRoot $strip
  Record "S3" "Passwordless sudo and wheel removed from the machine user (backups: /etc/sudoers.d/*.dashboard-bak)" "INFO" $x.out
  $st = Restart
  $su = InVm 'sudo -n true 2>&1 && echo SUDO-STILL-WORKS || echo no-sudo'
  Record "S4" "After restart: the machine user cannot sudo" $(if ($su.out -match "no-sudo" -and $su.out -notmatch "SUDO-STILL-WORKS") { "PASS" } else { "FAIL" }) "$($st.out)`n$($su.out)"
  $mc = InVm 'mkdir -p /tmp/wincheck; mount -t drvfs C: /tmp/wincheck 2>&1 && { echo MOUNTED-C; umount /tmp/wincheck; } || echo mount-refused'
  Record "S5" "The machine user cannot mount C:" $(if ($mc.out -match "MOUNTED-C") { "FAIL" } else { "PASS" }) $mc.out
  GvisorPod "S6" "After restart: rootless Podman with gVisor still works"
  $rp = PmRoot @("ps", "--format", "{{.Names}}")
  Record "S7" "The root connection still works (for host-side administration)" $(if ($rp.code -eq 0) { "PASS" } else { "FAIL" }) $rp.out
}

$json = ConvertTo-Json -InputObject @{ when = (Get-Date).ToString("o"); results = $results } -Depth 5
[IO.File]::WriteAllText((Join-Path $outDir "results.json"), $json, (New-Object Text.UTF8Encoding $false))
$fails = @($results | Where-Object { $_.outcome -eq "FAIL" }).Count
Write-Host "`n$($results.Count) checks, $fails failed. Results: $outDir   (undo the sudo change: -Restore)"
