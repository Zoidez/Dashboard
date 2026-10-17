<#
.SYNOPSIS
  Podman verification on this PC (docs/INFRASTRUCTURE.md, "Open items"). Run once after
  setup\install-podman.ps1. It records what actually happens; it changes nothing on Windows itself.

.DESCRIPTION
  Steps (each one is recorded as PASS, FAIL or INFO, and the run continues after a failure):
    S  Storage: the Podman machine is created with Podman's config and data pointed at Build\data\podman.
       PASS only if its files land there and nothing new appears in the user profile.
    M  The machine starts, runs rootless, and reports its Podman version.
    A  Open item 2: automatic mounting of Windows drives is switched off inside the machine
       (/etc/wsl.conf [automount] enabled=false, a backup is kept) and /mnt/c is gone after a restart.
    G  Open item 1: gVisor (runsc) is downloaded inside the machine, its SHA-512 checked, and a
       container is run with it (rootless, then rootless with ignore-cgroups, then rootful).
    K  Open item 3: which Kubernetes objects and fields `podman kube play` honours: Pod with limits,
       security settings and probes; ConfigMap and Secret as files; PersistentVolumeClaim; Deployment; Job.
    N  An internal network (--internal) has no route out.

  What it creates and keeps: the Podman machine "dashboard" (a WSL distribution named
  podman-dashboard, its disk under Build\data\podman\data) and one image (alpine). Test pods,
  volumes and networks are removed at the end. -RemoveMachine deletes the machine as well.
  WSL itself records the distribution in the user's registry (HKCU\...\Lxss); that one entry
  cannot live under Build\.

  Results: Build\data\podman\verify\<time>\results.json and log.txt.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\verify-podman.ps1
#>
param([switch]$RemoveMachine)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$repoRoot  = Split-Path -Parent $PSScriptRoot
$podmanDir = Join-Path $repoRoot "Build\data\podman"
$envFile   = Join-Path $podmanDir "env.ps1"
if (-not (Test-Path -LiteralPath $envFile)) { throw "Run setup\install-podman.ps1 first ($envFile is missing)." }
. $envFile

$Machine = "dashboard"
$Distro  = "podman-$Machine"
$Image   = "docker.io/library/alpine:3.20"
$stamp   = (Get-Date).ToString("yyyyMMdd-HHmmss")
$outDir  = Join-Path $podmanDir "verify\$stamp"
$kubeDir = Join-Path $outDir "kube"
New-Item -ItemType Directory -Force -Path $kubeDir | Out-Null
$logFile = Join-Path $outDir "log.txt"
$results = New-Object System.Collections.ArrayList

function Log([string]$s) { Add-Content -LiteralPath $logFile -Value $s -Encoding UTF8 }
function Record([string]$id, [string]$what, [string]$outcome, [string]$detail = "") {
  [void]$results.Add([ordered]@{ id = $id; check = $what; outcome = $outcome; detail = $detail })
  $c = @{ PASS = "Green"; FAIL = "Red"; INFO = "Gray" }[$outcome]
  Write-Host ("{0,-4} {1,-4} {2}" -f $outcome, $id, $what) -ForegroundColor $c
  if ($detail) { Write-Host "          $($detail -replace "`n", "`n          ")" }
  Log "[$outcome] $id $what`n$detail`n"
}
# Runs a native command; returns @{ code; out } with stdout and stderr together, and logs both.
function Run([string]$exe, [string[]]$argList) {
  Log "> $exe $($argList -join ' ')"
  $out = & $exe @argList 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $text = ($out -join "`n").Trim()
  Log "$text`n(exit $code)`n"
  return @{ code = $code; out = $text }
}
function Pm([string[]]$a) { return Run "podman" $a }
# Runs a shell script inside the machine; base64 avoids every quoting problem between PowerShell, ssh and sh.
function InVm([string]$script, [switch]$Sudo) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script.Replace("`r", "")))
  $sh = if ($Sudo) { "sudo sh" } else { "sh" }
  return Pm @("machine", "ssh", $Machine, "echo $b64 | base64 -d | $sh")
}
function WslList() { return ((& wsl.exe -l -q 2>&1) -join "`n") -replace "`0", "" }

Write-Host "Podman verification, results in $outDir`n"
$ver = Pm @("--version"); Record "V" "Podman client" "INFO" $ver.out

# ---------- S: storage stays under Build\data\podman ----------
$profilePlaces = @(
  (Join-Path $env:USERPROFILE ".config\containers"), (Join-Path $env:USERPROFILE ".local\share\containers"),
  (Join-Path $env:APPDATA "containers"), (Join-Path $env:LOCALAPPDATA "containers"), (Join-Path $env:USERPROFILE ".ssh")
)
function Snapshot { $h = @{}; foreach ($p in $profilePlaces) { if (Test-Path -LiteralPath $p) { Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $h[$_.FullName] = $_.LastWriteTimeUtc.Ticks } } }; return $h }
$before = Snapshot

$exists = (WslList) -split "`n" | Where-Object { $_.Trim() -eq $Distro }
if ($exists) {
  Record "S0" "Machine '$Machine' already exists; storage check skipped (it only means something on a fresh machine)" "INFO"
} else {
  $init = Pm @("machine", "init", "--cpus", "2", "--memory", "2048", "--disk-size", "20", $Machine)
  if ($init.code -ne 0) { Record "S1" "podman machine init" "FAIL" $init.out }
  else {
    Record "S1" "podman machine init" "PASS"
    $after = Snapshot
    $new = @($after.Keys | Where-Object { -not $before.ContainsKey($_) -or $before[$_] -ne $after[$_] })
    # Podman may add its machine key to ~/.ssh; list it separately from containers data.
    $newContainers = @($new | Where-Object { $_ -notlike "*\.ssh\*" })
    $newSsh = @($new | Where-Object { $_ -like "*\.ssh\*" })
    Record "S2" "No new Podman files in the user profile" $(if ($newContainers.Count) { "FAIL" } else { "PASS" }) (($newContainers | Select-Object -First 15) -join "`n")
    if ($newSsh.Count) { Record "S3" "Files written to ~/.ssh by machine init" "FAIL" (($newSsh | Select-Object -First 10) -join "`n") }
    $inBuild = @(Get-ChildItem -LiteralPath $podmanDir -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike "$outDir*" -and $_.Length -gt 100MB })
    Record "S4" "Machine disk (files over 100 MB) under Build\data\podman" $(if ($inBuild.Count) { "PASS" } else { "FAIL" }) (($inBuild | ForEach-Object { "$($_.FullName)  $([math]::Round($_.Length / 1MB)) MB" }) -join "`n")
  }
}
$lxss = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss" -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DistributionName -eq $Distro }
if ($lxss) { Record "S5" "WSL distribution $Distro lives under Build\data\podman" $(if ($lxss.BasePath -like "*$podmanDir*" -or $lxss.BasePath -like "*\\?\$podmanDir*") { "PASS" } else { "FAIL" }) "BasePath: $($lxss.BasePath)" }
else { Record "S5" "WSL distribution $Distro registered" "FAIL" "not found in HKCU Lxss; wsl -l: $(WslList)" }

# ---------- M: start, rootless ----------
$start = Pm @("machine", "start", $Machine)
$running = (Pm @("machine", "inspect", $Machine, "--format", "{{.State}}")).out
Record "M1" "Machine starts" $(if ($running -match "running") { "PASS" } else { "FAIL" }) "$($start.out)`nstate: $running"
$rootless = (Pm @("info", "--format", "{{.Host.Security.Rootless}}")).out
Record "M2" "Containers run rootless" $(if ($rootless -match "true") { "PASS" } else { "FAIL" }) "rootless: $rootless"
$info = Pm @("info", "--format", "{{.Version.Version}} / {{.Host.Distribution.Distribution}} {{.Host.Distribution.Version}} / kernel {{.Host.Kernel}} / cgroups {{.Host.CgroupsVersion}}")
Record "M3" "Machine Podman, distribution, kernel" "INFO" $info.out

# ---------- A: no Windows drives inside the machine (open item 2) ----------
$mBefore = InVm "mount | grep -Ei ' /mnt/[a-z] |drvfs|9p' ; echo; cat /etc/wsl.conf 2>/dev/null"
Record "A1" "Windows drive mounts and /etc/wsl.conf before" "INFO" $mBefore.out
$fix = @'
f=/etc/wsl.conf
touch $f
[ -f $f.dashboard-bak ] || cp $f $f.dashboard-bak
if grep -q '^\[automount\]' $f; then
  sed -i '/^\[automount\]/,/^\[/{/^enabled[ ]*=/d;/^mountFsTab[ ]*=/d}' $f
  sed -i '/^\[automount\]/a enabled=false\nmountFsTab=false' $f
else
  printf '\n[automount]\nenabled=false\nmountFsTab=false\n' >> $f
fi
cat $f
'@
$w = InVm $fix -Sudo
Record "A2" "Set [automount] enabled=false in /etc/wsl.conf (backup: /etc/wsl.conf.dashboard-bak)" $(if ($w.code -eq 0) { "INFO" } else { "FAIL" }) $w.out
[void](Pm @("machine", "stop", $Machine)); [void](Run "wsl.exe" @("--terminate", $Distro))
$start2 = Pm @("machine", "start", $Machine)
$mAfter = InVm "mount | grep -Ei ' /mnt/[a-z] |drvfs|9p' ; ls /mnt 2>&1; test -e /mnt/c/Windows && echo WINDOWS-C-VISIBLE || echo no-windows-c"
$sees = $mAfter.out -match "WINDOWS-C-VISIBLE" -or $mAfter.out -match "drvfs"
Record "A3" "After restart: no Windows drive mounted, machine still starts" $(if (-not $sees -and $start2.code -eq 0) { "PASS" } else { "FAIL" }) "$($start2.out)`n$($mAfter.out)"
Record "A4" "Survives Podman updates?" "INFO" "Not testable now. Re-run this script after every Podman update (it re-checks A3)."

# ---------- G: gVisor (open item 1) ----------
$g = @'
set -e
cd /tmp
U=https://storage.googleapis.com/gvisor/releases/release/latest/x86_64
curl -fsSLO "$U/runsc" && curl -fsSLO "$U/runsc.sha512"
sha512sum -c runsc.sha512
sudo install -m 755 runsc /usr/local/bin/runsc
/usr/local/bin/runsc --version
'@
$gi = InVm $g
Record "G1" "runsc downloaded, SHA-512 checked, installed in the machine" $(if ($gi.code -eq 0 -and $gi.out -match "runsc version") { "PASS" } else { "FAIL" }) $gi.out
[void](Pm @("pull", "-q", $Image))
$digest = (Pm @("image", "inspect", $Image, "--format", "{{.Digest}}")).out
Record "G0" "Test image" "INFO" "$Image  $digest"
$hostKernel = (InVm "uname -r").out
$gvOk = $false
foreach ($v in @(
  @{ n = "rootless"; s = "podman --runtime /usr/local/bin/runsc run --rm $Image uname -r" },
  @{ n = "rootless, ignore-cgroups"; s = "podman --runtime /usr/local/bin/runsc --runtime-flag ignore-cgroups run --rm $Image uname -r" },
  @{ n = "rootful"; s = "sudo podman --runtime /usr/local/bin/runsc run --rm $Image uname -r" })) {
  if ($gi.code -ne 0) { break }
  $r = InVm $v.s
  $sandboxed = $r.code -eq 0 -and $r.out -and ($r.out.Trim() -split "`n")[-1] -ne $hostKernel
  Record "G2" "Container under gVisor ($($v.n))" $(if ($sandboxed) { "PASS" } else { "FAIL" }) "host kernel $hostKernel`n$($r.out)"
  if ($sandboxed) { $gvOk = $true; break }
}

# ---------- K: podman kube play (open item 3) ----------
$sec = @"
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
"@
$files = [ordered]@{
  "pod" = @"
apiVersion: v1
kind: Pod
metadata: { name: verify-pod }
spec:
  containers:
    - name: main
      image: $Image
      command: ["sh", "-c", "sleep 3600"]
      resources:
        requests: { cpu: "100m", memory: "32Mi" }
        limits: { cpu: "500m", memory: "64Mi" }
$sec
      livenessProbe: { exec: { command: ["true"] }, periodSeconds: 30 }
      readinessProbe: { exec: { command: ["true"] }, periodSeconds: 30 }
"@
  "config" = @"
apiVersion: v1
kind: ConfigMap
metadata: { name: verify-cm }
data: { setting: "from-configmap" }
---
apiVersion: v1
kind: Secret
metadata: { name: verify-secret }
stringData: { token: "from-secret" }
---
apiVersion: v1
kind: Pod
metadata: { name: verify-config }
spec:
  containers:
    - name: main
      image: $Image
      command: ["sh", "-c", "sleep 3600"]
$sec
      volumeMounts:
        - { name: cm, mountPath: /etc/cfg, readOnly: true }
        - { name: sec, mountPath: /run/secrets/app, readOnly: true }
  volumes:
    - { name: cm, configMap: { name: verify-cm } }
    - { name: sec, secret: { secretName: verify-secret } }
"@
  "pvc" = @"
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: verify-pvc }
spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: 64Mi } } }
---
apiVersion: v1
kind: Pod
metadata: { name: verify-pvc-pod }
spec:
  containers:
    - name: main
      image: $Image
      command: ["sh", "-c", "echo kept > /data/f && sleep 3600"]
      volumeMounts: [{ name: d, mountPath: /data }]
  volumes: [{ name: d, persistentVolumeClaim: { claimName: verify-pvc } }]
"@
  "deployment" = @"
apiVersion: apps/v1
kind: Deployment
metadata: { name: verify-deploy }
spec:
  replicas: 1
  selector: { matchLabels: { app: verify-deploy } }
  template:
    metadata: { labels: { app: verify-deploy } }
    spec:
      containers: [{ name: main, image: $Image, command: ["sh", "-c", "sleep 3600"] }]
"@
  "job" = @"
apiVersion: batch/v1
kind: Job
metadata: { name: verify-job }
spec:
  template:
    spec:
      restartPolicy: Never
      containers: [{ name: main, image: $Image, command: ["sh", "-c", "echo job-ok"] }]
"@
}
foreach ($k in $files.Keys) { [IO.File]::WriteAllText((Join-Path $kubeDir "$k.yaml"), $files[$k].Replace("`r", ""), (New-Object Text.UTF8Encoding $false)) }
function Play($k) { return Pm @("kube", "play", (Join-Path $kubeDir "$k.yaml")) }
function Ctr($pod) { return "$pod-main" }

$p = Play "pod"
if ($p.code -ne 0) { Record "K1" "kube play: Pod" "FAIL" $p.out }
else {
  Record "K1" "kube play: Pod" "PASS"
  $c = Ctr "verify-pod"
  $j = (Pm @("inspect", $c, "--format", "{{json .HostConfig.Memory}}|{{json .HostConfig.NanoCpus}}|{{json .HostConfig.CpuQuota}}|{{json .HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .Config.User}}|{{json .Config.Healthcheck}}")).out
  $parts = $j -split "\|"
  Record "K2" "Memory limit 64Mi honoured" $(if ($parts[0] -eq "67108864") { "PASS" } else { "FAIL" }) "Memory=$($parts[0])"
  Record "K3" "CPU limit honoured" $(if (($parts[1] -ne "0" -and $parts[1]) -or ($parts[2] -ne "0" -and $parts[2])) { "PASS" } else { "FAIL" }) "NanoCpus=$($parts[1]) CpuQuota=$($parts[2])"
  Record "K4" "readOnlyRootFilesystem honoured" $(if ($parts[3] -eq "true") { "PASS" } else { "FAIL" }) "ReadonlyRootfs=$($parts[3])"
  Record "K5" "capabilities drop ALL honoured" $(if ($parts[4] -match "ALL|CAP_") { "PASS" } else { "FAIL" }) "CapDrop=$($parts[4])"
  Record "K6" "allowPrivilegeEscalation=false -> no-new-privileges" $(if ($parts[5] -match "no-new-privileges") { "PASS" } else { "FAIL" }) "SecurityOpt=$($parts[5])"
  Record "K7" "runAsUser 10001 honoured" $(if ($parts[6] -match "10001") { "PASS" } else { "FAIL" }) "User=$($parts[6])"
  Record "K8" "Probes become a health check" $(if ($parts[7] -and $parts[7] -ne "null") { "PASS" } else { "FAIL" }) "Healthcheck=$($parts[7])"
  $wr = Pm @("exec", $c, "sh", "-c", "touch /x 2>&1; echo exit=`$?")
  Record "K9" "Root filesystem really read-only" $(if ($wr.out -match "Read-only|exit=1") { "PASS" } else { "FAIL" }) $wr.out
}
$p = Play "config"
if ($p.code -ne 0) { Record "K10" "kube play: ConfigMap + Secret as files" "FAIL" $p.out }
else {
  $c = Ctr "verify-config"
  $r = Pm @("exec", $c, "sh", "-c", "cat /etc/cfg/setting; echo; cat /run/secrets/app/token; echo; env | grep -c from-secret")
  Record "K10" "ConfigMap and Secret mounted as files (secret not in env)" $(if ($r.out -match "from-configmap" -and $r.out -match "from-secret" -and ($r.out.Trim() -split "`n")[-1] -eq "0") { "PASS" } else { "FAIL" }) $r.out
}
$p = Play "pvc"
if ($p.code -ne 0) { Record "K11" "kube play: PersistentVolumeClaim" "FAIL" $p.out }
else { $v = Pm @("volume", "inspect", "verify-pvc", "--format", "{{.Name}} {{.Driver}}"); Record "K11" "PersistentVolumeClaim becomes a named volume" $(if ($v.code -eq 0) { "PASS" } else { "FAIL" }) $v.out }
$p = Play "deployment"
Record "K12" "kube play: Deployment" $(if ($p.code -eq 0) { "PASS" } else { "FAIL" }) $p.out
$p = Play "job"
if ($p.code -ne 0) { Record "K13" "kube play: Job" "FAIL" $p.out }
else {
  Start-Sleep -Seconds 5
  # The Job's pod and container names are Podman's choice: take the job's non-infra container.
  $l = Pm @("ps", "-a", "--filter", "name=verify-job", "--format", "{{.Names}} {{.Status}}")
  $jobCtr = ($l.out -split "`n" | ForEach-Object { ($_ -split " ")[0] } | Where-Object { $_ -and $_ -notmatch "infra" } | Select-Object -First 1)
  $logs = if ($jobCtr) { Pm @("logs", $jobCtr) } else { @{ code = 1; out = "no job container found" } }
  Record "K13" "kube play: Job runs to completion" $(if ($logs.out -match "job-ok") { "PASS" } else { "FAIL" }) "$($p.out)`n$($l.out)`n$($logs.out)"
}

# ---------- N: internal network has no route out ----------
[void](Pm @("network", "create", "--internal", "verify-internal"))
$n = Pm @("run", "--rm", "--network", "verify-internal", $Image, "sh", "-c", "wget -q -T 5 -O- http://1.1.1.1 >/dev/null 2>&1 && echo REACHED || echo blocked; nslookup example.com >/dev/null 2>&1 && echo DNS-RESOLVED || echo no-dns")
Record "N1" "Internal network: no route out" $(if ($n.out -match "blocked" -and $n.out -notmatch "REACHED") { "PASS" } else { "FAIL" }) $n.out

# ---------- cleanup ----------
foreach ($k in $files.Keys) { [void](Pm @("kube", "down", (Join-Path $kubeDir "$k.yaml"))) }
[void](Pm @("volume", "rm", "-f", "verify-pvc")); [void](Pm @("network", "rm", "-f", "verify-internal"))
if ($RemoveMachine) { [void](Pm @("machine", "rm", "-f", $Machine)); Record "C1" "Machine removed (-RemoveMachine)" "INFO" }

$json = ConvertTo-Json -InputObject @{ when = (Get-Date).ToString("o"); podman = $ver.out; machine = $Machine; image = "$Image $digest"; results = $results } -Depth 5
[IO.File]::WriteAllText((Join-Path $outDir "results.json"), $json, (New-Object Text.UTF8Encoding $false))
$fails = @($results | Where-Object { $_.outcome -eq "FAIL" }).Count
Write-Host "`n$($results.Count) checks, $fails failed. Results: $outDir"
