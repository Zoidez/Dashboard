# Dashboard — Container infrastructure (Podman now, Kubernetes-ready)

**Decision (user, 2026-10-13):** containers run on **Podman**. Everything is built so it can move to **Kubernetes** later without being redesigned. The rules below are what makes that possible. Each rule says why.

## Scope

**Now:** the containers LASS uses for fix runs: Claude Code with full development tools, sealed off from Windows (LASS.md, sections 8 and 9a).

**Later, if the Dashboard becomes a hosted service:**
- the generator, through the Claude API
- card workers running as pods
- the services around them: accounts, database, update distribution

The same rules apply from the first container on, so nothing has to be rebuilt for that step.

**Planned (user decision 2026-10-13):** card **workers** in containers, one card per container (section "Container card workers").

**Not in containers, now or later:**
- the Electron app and its broker
- card **UIs**, which stay in their Electron sandboxes
- local capabilities: files, PC info, report folders
- the Windows-only tests: card sandbox, junction races, process checks

These need the user's Windows. In a hosted future they become the local agent app that connects to the service.

## Platform on this PC

- **Windows 11 Home.** Podman runs its containers inside a WSL2 virtual machine ("Podman machine"), set up with `podman machine init`. Requirements:
  - the Virtual Machine Platform feature
  - virtualization enabled in the firmware (Task Manager > Performance > CPU: "Virtualization: Enabled")
- **Windows Sandbox and Hyper-V Manager are not available on Home.** A patch from a fix run is tested on the real Windows after the user approves it (LASS.md, section 8).
- **Cost:** Podman is free (Apache 2.0), with no licence conditions. That fits "no additional payments".

## Rules

### Images

**I1. Standard images, built from recipes in the repository.**
- Every image is built from a Containerfile under `infra/images/<name>/`, and only from there.
- Base images are pinned by digest (`FROM image@sha256:…`), not by tag.
- Images are tagged with the git commit they were built from and referenced by digest.

*Why:* Podman and Kubernetes run the same standard image format (OCI). Pinning makes a build reproducible and stops a base-image update from changing what runs.

**I2. No secrets in images.** No login tokens, keys, `.npmrc` with tokens, or Claude config in any image layer.

*Why:* anything in a layer is readable by anyone who has the image, forever.

**I3. Small and non-root.**
- Images contain only what the job needs.
- They declare a non-root user (`USER 10001`).
- They run with a read-only root filesystem: writable paths are explicit volumes or temporary folders.

*Why:* less to attack, and Kubernetes' restricted pod security settings require it anyway.

### Describing what runs

**D1. Kubernetes YAML is the only description of what runs.**
- Every pod, its containers, volumes, limits and health checks is written as Kubernetes YAML under `infra/k8s/`.
- Podman runs it with `podman kube play`. Services that must start at boot use Podman's systemd units (Quadlet `.kube` files) that point at the same YAML.

*Why:* the same files later go to a cluster.

**D2. Stay inside what Podman supports.** `podman kube play` implements only part of Kubernetes: pods, deployments, config maps, secrets, persistent volume claims and some more.
- Use nothing outside that part.
- When a new kind of object is needed, check first that Podman supports it, and record the check here.

*Why:* YAML that Podman ignores or rejects gives a false sense of portability.

**D3. No hand-made `podman run` commands anywhere the Dashboard depends on.**
- Developer convenience scripts are allowed, but the Dashboard never calls them.
- The Dashboard starts containers only through the backend in rule O1.

*Why:* hand-tuned command flags are the main thing that has to be found and rewritten in a migration.

**D4. Resource limits and health checks in the YAML.**
- Every container has CPU and memory `requests` and `limits`.
- Long-running services have readiness and liveness probes.

*Why:* Kubernetes needs them to schedule and heal pods. Podman can use the probes as health checks; how far it honours them is to be verified (open item 3).

### State, configuration, secrets

**S1. No state inside containers.**
- Anything that must survive a restart lives in a declared volume (a persistent volume claim), and later in a database or object storage.
- A container can be deleted and recreated at any time without losing anything.

*Why:* Kubernetes moves pods by killing and recreating them.

**S2. Configuration through environment variables or config files from ConfigMaps.**

*Why:* they map one-for-one to Kubernetes ConfigMaps.

**S3. Secrets as mounted files from Secrets, never in environment variables or command lines.**

*Why:* environment variables and command lines leak into logs, crash dumps and process listings.

**S4. The Claude login of a LASS container.**
- The user signs in once, interactively, inside the container: an approved one-time step.
- The login is stored in its own volume, `lass-claude-config`. The Dashboard never reads it (RULES.md, Binary and config 3).
- No other container mounts that volume.

### Network

**N1. Names, not addresses.**
- Services reach each other by DNS name.
- No host networking, no fixed IP addresses.
- No published host ports, except ones listed here with a reason.

*Why:* addresses change in a cluster; names don't.

**N2. All outbound traffic through one egress proxy.**
- Every container that needs the internet goes through the project's own egress proxy, itself a container. The allowlist lives in the proxy's ConfigMap.
- The container network allows nothing else.
- LASS allowlist: the Claude API and sign-in endpoints, the npm registry and GitHub.
- In a hosted future, each card's network permission becomes the proxy's rules for that card.

*Why:* permissions enforced in your own proxy are the same on Podman and Kubernetes. On Kubernetes a NetworkPolicy then only has to say "talk only to the proxy". Rules written as Podman firewall settings would have to be redone.

**N3. Inbound only through one entry point** (hosted future): a reverse proxy or ingress with TLS. Nothing else accepts outside connections.

### Isolation

**X1. A sandbox runtime for code nobody reviewed.**
- The LASS agent, and later the cards' server-side workers, run under **gVisor** (`runsc`) or Kata Containers.
- Podman: `--runtime=runsc`. Kubernetes: the same runtime through a RuntimeClass.
- Availability inside the Podman machine on this PC is not yet verified (open item 1).
- Until it is, the fallback is rule X2. That is weaker, and LASS.md's rule still holds: the user's click starts the rollout.

*Why:* ordinary containers share a kernel. Code written by an AI from untrusted input needs a stronger wall.

**X2. Least privilege in every container:**
- rootless Podman
- non-root user
- all Linux capabilities dropped
- `no-new-privileges`
- read-only root filesystem
- the default seccomp profile

*Why:* it limits what a compromised container can do, and it matches Kubernetes' "restricted" pod security level.

**X3. Nothing from the host goes in.**
- No container gets the Podman API socket.
- No container gets a Windows folder, and the Podman machine's automatic mounting of Windows drives is switched off (open item 2).
- Input is copied in. Output (a LASS patch and its report) is copied out by the backend in rule O1.

*Why:* the socket or a mounted Windows folder ends the isolation completely.

### Orchestration

**O1. One container backend interface in the Dashboard.** `src/main/containers/backend.ts` with:

```ts
interface ContainerBackend {
  start(spec: JobSpec): Promise<JobId>;      // spec = what to run, limits, inputs, network profile
  status(id: JobId): Promise<JobStatus>;
  logs(id: JobId): AsyncIterable<string>;
  copyIn(id: JobId, files: FileSet): Promise<void>;
  copyOut(id: JobId, path: string): Promise<FileSet>;
  stop(id: JobId): Promise<void>;            // always removes the container and its scratch volumes
}
```

- The Podman backend renders a `JobSpec` into Kubernetes YAML (rule D1) and runs it with `podman kube play` / `podman kube down`.
- A Kubernetes backend later creates the same YAML through the Kubernetes API, as a Job.
- Nothing outside this module knows which backend is in use.

*Why:* this backend is the only code that has to be written twice.

**O2. Identity and permissions belong to the application, not to Podman or Kubernetes.**
- Users, admin and system accounts, and their roles live in the application (later an identity provider plus roles in the service's code).
- Kubernetes' own access control (RBAC) is only for the people and processes that operate the cluster.

*Why:* neither Podman nor Kubernetes knows your users. Putting user permissions in the orchestrator would tie them to it.

### Observability

**L1. Logs as structured JSON on standard output.** No log files inside containers. The backend collects logs and stores them with the investigation or job.

*Why:* both platforms collect standard output; files inside a deleted container are gone.

**L2. Metrics and traces through OpenTelemetry** when they are needed. No platform-specific monitoring agents.


## Container card workers (planned; user decision 2026-10-13)

**Status:** design only, not built.

**Order:** after the Podman verification, the development container, the container backend (rule O1) and LASS phases 1–2.

**Effort:** about 3–5 working days at this project's pace (the app core was built in one day on 2026-10-09), about a week with real-world snags. The pace is set by the user's verification runs on the PC and by plan usage limits, not by writing code. (Corrected 2026-10-13 from an earlier "1–2 weeks", which was a human-developer estimate.)

### Required rule changes before building (reminder, user request 2026-10-13)

These rules forbid parts of this design today. **They stay in force until the user approves each change explicitly.** Whoever starts this work (Claude or Claude Code) must first remind the user of this list and get that approval. CLAUDE.md says the same.

| Rule today | Where | Change needed | Needed for |
|---|---|---|---|
| "Cards never get Node.js, direct network, DLL calls, program launching, or Claude." | CLAUDE.md, Hard constraints | Allow a JavaScript runtime **inside a sealed worker container** (file system and child processes off, no route out). Keep the ban everywhere else, including on Windows. | Any container worker |
| Host invariant 7: card code runs only in its own sandboxed renderer; no Node.js, no direct network | RULES.md | Add container workers as a second allowed place for card **worker** code, under rules W1–W7. Card UIs stay in renderers. | Any container worker |
| Host invariant 11: running or launching executables is reserved | RULES.md | Allow programs **inside the card's own container only**, as a new permission the user approves at install. Executables on Windows stay forbidden. | Only cards that use real programs (Python, ffmpeg) |
| Manifest schema: `process` permissions reserved and rejected | `spec/manifest.schema.json`, VALIDATOR.md | A new permission (e.g. `compute.container`, `program.run` scoped to the container), with its reason shown at approval | As for invariant 11 |
| Generator system prompt: "The card has no Node.js and no direct network…" | GENERATOR-PROMPT.md (and RULES.md generator rules) | Describe the container worker runtime and its `api`, for cards built to use it | When the generator starts writing container workers |
| ARCHITECTURE.md process model | ARCHITECTURE.md | Add the Podman machine, the card network, the bus, the gateway and the monitor | Before the first container worker runs |

Each change is recorded in PROJECT.md's decision log when the user approves it.

### What moves and what stays

- **Moves:** a card's background **worker** (`worker.js`) runs in its own container, one container per card. Cards with no worker, or a trivial one, may stay entirely in Electron.
- **Stays:**
  - The card's **UI** stays in its Electron sandbox, in the Dashboard window. A Linux container cannot draw into a Windows window.
  - Local capabilities stay with the Windows broker: files, PC info, report folders, links.

### Why (the reasons the user accepted)

1. **"Offline" becomes a kernel guarantee.** A worker sits on a network with no route out. To reach the internet it would first have to escape its container (and gVisor). In the Electron sandbox, "offline" is enforced by Chromium and the broker, at application level.
2. **An independent witness.** The network layer records every connection whatever the broker believes. The two records are compared (section "Monitoring").
3. **Standard, mature tooling:** per-client certificates, message-bus access rules, proxies with request logs, flow logs, intrusion detection, OpenTelemetry.
4. **Per-card limits enforced by Linux:** CPU, memory, processes, network.
5. **Expansion points.** Every hop is a place to add checks later without touching cards.
6. **A path to cards that use real programs** (Python, ffmpeg) inside the container. This needs an amendment of host invariant 11 (running programs is reserved) before it is allowed. Until then, workers run only JavaScript.
7. **The hosted-service shape.** In a hosted version, workers would be pods anyway.

### Topology

```
Windows                                  | Podman machine (WSL2)
                                         |
Dashboard (Electron)                     |   network "cards-internal"  (--internal: no gateway, no route out)
  card UIs (Electron sandboxes)          |     worker-<card-a>   worker-<card-b>   ...
  broker (decides every capability) <====|====> message bus (NATS) <---- all workers, per-card credentials
                                         |     egress gateway  <--- the only container on both networks
                                         |   network "egress"
                                         |     egress gateway ---> internet (only hosts a card was approved for)
                                         |     monitor (reads gateway logs and capture on cards-internal)
```

### Rules

**W1. One worker per container, from a common worker image.**
- The image holds a locked-down JavaScript runtime (Deno or Node with file system and child processes switched off) and the same `api` cards use today.
- The card's own files are copied in when it starts. They are never mounted from Windows.
- The image and the YAML follow rules I1–I3, D1–D4 and X1–X3.
- **Conflict to resolve when this is built:** CLAUDE.md's hard constraint says cards never get Node.js. A JavaScript runtime sealed inside a container, with its file system and process access switched off and no route out, is not Node on the user's machine. The constraint and host invariant 7 must be amended explicitly at that point; until then they stand.

**W2. The card network has no way out.**
- Workers sit only on `cards-internal`, an internal Podman network with no gateway.
- They can reach two things: the message bus and the egress gateway. Nothing else listens there.
- No published ports.

**W3. One standard message bus, NATS** (MQTT was the alternative; NATS chosen for built-in request/reply and per-account permissions).
- **Per-card identity:** each worker gets its own credentials (an NKey or a client certificate) at start. They are created by the broker, valid only for that run, and revoked when the card stops.
- **Per-card subjects:** a worker may only publish and subscribe on `card.<card-id>.>` subjects. Bus permissions enforce this, so a worker cannot read or impersonate another card.
- **The broker on Windows is the only decision-maker.** It subscribes to the request subjects, checks each request against the card's approval (version hash, scope, not revoked, granted lazily) and answers. The bus is transport only; it never decides anything.
- **Documented schema:** messages follow the existing protocol in `src/shared/protocol.ts`. It is versioned, strictly validated and public. Security comes from identity and policy checks, never from a secret format.
- **Stop withdraws everything:** credentials revoked, subscriptions closed, container killed, in-flight requests answered with an error. This is the same lazy-grant rule as host invariant 4.

**W4. Internet access only through the egress gateway, and only with a grant.**
- Online requests go to the gateway: card identity, plus a short-lived grant the broker issues for one approved host pattern.
- The gateway checks the grant and the card's identity, makes the request, and logs it in clear text (request line, host, sizes, timing, status; bodies only as hashes and size).
- Cards without a network permission never receive a grant, so the gateway refuses them.
- The gateway also enforces DNS pinning and redirect checks, ported from the current broker network client (test A2).

**W5. Workers exist only while needed.**
- A worker container starts when its schedule fires, when its card is opened, or when its UI calls it. It stops after an idle timeout.
- Cards that need a constant connection may stay up; that is declared in the manifest and shown at approval.
- Cold start (about 1–2 s, plus the Podman machine's own start if it isn't running) is accepted.

**W6. Local capabilities never leave Windows.**
- File access, PC info and report reading are answered by the broker on Windows, through the bus, under the existing permission rules.
- The worker gets the answer, never a mounted folder.
- Every answer that crosses into the Podman machine is logged with its size.

**W7. The security tests are re-proven for container workers before any card uses them.** Each of A1–A11 gets a container version (e.g. A2: network blocked at the kernel and at the gateway), plus new tests:
- a worker cannot reach another worker
- a worker cannot use another card's bus subjects
- a revoked card's credentials stop working at once
- no route out exists from `cards-internal`

### Monitoring

**M1. Trustworthy records only from points a card does not control:**
- the broker's event log (OpenTelemetry; also the core of the LASS activity log)
- the egress gateway's request log
- the bus's connection and permission log
- packet or flow capture on `cards-internal` in the Podman machine

A card's own logs are not evidence: a compromised card writes them.

**M2. A monitor container** reads those records. It has no write access to anything it watches, and no internet.

**M3. Rule monitor (first).** The system is a closed world: every card's manifest lists exactly what it may do. Each of these is an alert:
- any flow, host, subject or capability outside a card's approved permissions
- any traffic on `cards-internal` that didn't go through the bus or the gateway
- any difference between the broker's record and the network's record

**M4. Statistical monitor (second).** Per-card baselines: requests per hour, bytes in and out, new endpoints within allowed hosts, unusual hours. Large deviations are alerts. This catches abuse inside the allowed hosts, which rules can't see.

**M5. Neural monitor (later, optional experiment).**
- A small model trained on months of real records from M1, not on synthetic attacks alone.
- It adds alerts; it never removes rule or statistics alerts.
- Kept only if it finds things M3 and M4 miss, at a false-alarm rate the user accepts.

**M6. Escalation to Claude (LASS).** An alert opens a LASS investigation. What Claude receives:
- **Structured fields:** card, rule or baseline that fired, hosts, subjects, sizes, counts, timings, payload hashes.
- **At most a short payload excerpt,** truncated, escaped and marked untrusted.

No sanitizer can make free text injection-proof, so Claude reads it with no tools and writes a report (LASS.md, section 6). Any fix follows LASS's click-to-start and click-to-roll-out rules. On a high-severity alert the monitor may stop the card at once, the same as the user pressing Stop. The user is told.

### Open items

1. NATS server and client footprint in the Podman machine; credential issuance from the Windows broker.
2. Reaching the bus from the Windows broker: a published port on the Podman machine's address only, with a Windows firewall rule limited to it.
3. Which JavaScript runtime gives the tightest lockdown with the current card `api`.
4. Capture on `cards-internal` inside the Podman machine, and its storage cost.
5. Whether gVisor runs inside the Podman machine on Windows 11 Home (open item 1 above, also needed here).

## Repository layout

```
infra/
  images/<name>/Containerfile       recipes (I1)
  k8s/<name>.yaml                   what runs (D1)
  quadlet/<name>.kube               boot units pointing at the YAML (D1)
  proxy/allowlist.yaml              egress allowlist ConfigMap (N2)
  images/card-worker/Containerfile  common worker image (W1)
  k8s/cards-internal.yaml, egress-gateway.yaml, nats.yaml, monitor.yaml
src/main/containers/                backend interface and Podman backend (O1)
```

## Moving to Kubernetes later

1. Choose the cluster: managed, or self-hosted k3s.
2. Install a network plugin that enforces NetworkPolicy. Add the policy "only the egress proxy may go out".
3. Install the sandbox runtime and its RuntimeClass (X1).
4. Write the Kubernetes backend of rule O1, and switch to it.
5. Map persistent volume claims to a storage class, or move state to a managed database or object storage.
6. Set up ingress with TLS (N3), cluster backups, upgrades and pod security admission at "restricted".
7. Run old and new side by side for the customer, switch over, keep the way back until the new setup has been stable for a set period.

If the rules above were followed, steps 1–6 are configuration, not redesign. Step 4 is the only code.

## Verified on this PC (2026-10-17, `setup\verify-podman.ps1`, Podman 6.1.4, machine Fedora 44, WSL kernel 6.18)
Results: `Build\data\podman\verify\20261017-055713\`.

| Open item | Answer |
|---|---|
| Storage under `Build\` | **Yes, with a redirected home.** Podman 6 on Windows keeps the machine's config under `USERPROFILE`/`APPDATA` whatever `XDG_CONFIG_HOME` says. Pointing those (and `HOME`, `LOCALAPPDATA`) at `Build\data\podman\home` for each podman call puts everything under `Build\`: machine config, connections, disk (`ext4.vhdx`), image cache. The WSL distribution's `BasePath` is under `Build\`; only WSL's own registry entry (`HKCU\...\Lxss`) is outside. **The container backend (O1) must start podman with this environment.** |
| 2. Windows drives off | **Automount off works and survives a restart** (`/etc/wsl.conf` `[automount] enabled=false`); Windows interop off works (`[interop] enabled=false`). Persistence across Podman updates: re-run the script after each update. |
| 2a. Is the machine a wall? | **No.** Root inside the machine can still mount `C:` by hand (`mount -t drvfs C:`), with the Windows user's rights, and the machine's user has `sudo` without a password. So anything that reaches the machine's user or root can reach the user's files. Rule X3 cannot rest on the machine; it rests on the container boundary (gVisor, rootless, no sudo). |
| 1. gVisor | **Works rootless only with `--runtime-flag ignore-cgroups`** (kernel `4.19.0-gvisor` seen inside). Without it, runsc cannot set up cgroups. gVisor ships as `gvisor.tar.zstd` + `.sha512` now (runsc alone is gone). Rootful gVisor not tested yet. |
| Limits (D4) | **Rootless containers get no CPU or memory limits** in Podman's WSL machine (cgroup controllers are not delegated to the user: `memory.max` missing). Rootful containers get them (64Mi and the CPU limit honoured). |
| 3. `podman kube play` | Pod (rootful: limits, `readOnlyRootFilesystem`, capabilities drop ALL, `allowPrivilegeEscalation: false` → `no-new-privileges`, `runAsUser`, probes → health check, root filesystem really read-only), ConfigMap and Secret as files (secret not in the environment), PersistentVolumeClaim → named volume, Deployment, **Job** (runs to completion): all supported. |
| Network | An `--internal` network has no route out (N2/W2 basis). |

**Decided (user, 2026-10-17): option A for the development / LASS container: rootless + gVisor (`--ignore-cgroups`) + the machine user without passwordless sudo.** Isolation from the user's files comes first; per-container limits are given up there (one fix run at a time). Card workers, which need limits more, are decided when they are built. Checked by `setup\verify-podman-isolation.ps1`, which also sets the machine up that way (`-Restore` undoes the sudo change). Background, before the decision: in this machine a container can be rootless *or* have limits, not both, and gVisor rootless also gives up limits. Not yet tested: rootful gVisor with limits; removing the machine user's passwordless `sudo`; whether `podman machine init --cpus/--memory` limits the WSL machine at all (WSL normally takes its limits from the user's global `.wslconfig`).

### Isolation checks (2026-10-17, `setup\verify-podman-isolation.ps1`; results `Build\data\podman\verify\20261017-060617-isolation\`)
| Check | Answer |
|---|---|
| Whole-machine limits | **None.** `podman machine init --cpus 2 --memory 2048` has no effect on WSL: the machine sees all 20 CPUs and 31 959 MB (WSL's default, half the RAM). WSL takes machine limits only from the user's global `%USERPROFILE%\.wslconfig`. |
| Rootful gVisor | **Runs and enforces limits** (a container holding 150 MB under a 64 MB limit is killed, exit 137), the same as rootful runc. Option B (rootful + gVisor + limits) is therefore possible, at the cost that a gVisor escape lands as root in the machine, where `C:` can be mounted. |
| Option A set up on this machine | gVisor is the machine user's default runtime (`/usr/local/bin/runsc-rootless` = `runsc --ignore-cgroups`, set in `~/.config/containers/containers.conf.d/50-dashboard-gvisor.conf`); a hardened Pod from `podman kube play` runs under gVisor rootless (`4.19.0-gvisor`). |
| No sudo | The user's sudo came from `%wheel ... NOPASSWD: ALL` in `/etc/sudoers`; the user was removed from `wheel`. After a restart the user cannot sudo and cannot mount `C:` ("must be superuser"); rootless gVisor and the root connection still work. `-Restore` adds the user to `wheel` again. |
| Consequence | Under option A a runaway container is limited by nothing: it can use all 20 CPUs and up to 32 GB. See open item 6. |
| Machine cap (user decision, option 1) | `%USERPROFILE%\.wslconfig`: `memory=12GB`, `processors=8`, `swap=4GB`, written by the user. After `wsl --shutdown` the machine shows 8 CPUs, 11 963 MB and 4 096 MB swap (2026-10-17). Drives, interop, sudo and the gVisor wrapper survived the WSL restart. |

### Development / LASS container (built 2026-10-17)
Files: `infra/images/lass-dev/Containerfile` (node 24 slim by digest, git, curl, Claude Code 2.1.296, user 10001), `infra/images/egress-proxy/` (alpine by digest, Squid), `infra/proxy/allowlist.yaml` (ConfigMap), `infra/k8s/lass-dev.yaml` and `lass-egress.yaml` (`{{IMAGE}}` filled in with the image tagged by git commit). `setup\lass-dev.ps1` builds, starts and checks them (a developer script; the Dashboard will use the backend, O1).

| Check (`setup\lass-dev.ps1`) | Result |
|---|---|
| Dev container | gVisor, user 10001, read-only root, Claude Code 2.1.296 |
| Allowed host through the proxy | reached (api.anthropic.com, HTTP 404 from the API root) |
| Host not on the allowlist | refused by the proxy (403) |
| Without the proxy | nothing reached (no DNS for outside names, no route) |
| Windows drives, Podman socket | none inside |
| Proxy log | every CONNECT on standard output, allowed and denied |

What it took (all in `/usr/local/bin/runsc-rootless`, the machine user's default runtime):
- `--overlay2=none`: gVisor otherwise keeps a container's writes in sandbox memory, so image builds produced empty layers.
- `--network=host`: containers of one pod share the pod's network namespace; with a netstack per gVisor container, the pod's infra container and the app container answered for the same address and DNS replies went astray. Host here means the pod's own namespace (isolated by Podman), not the machine's.
- `--no-new-keyring` is dropped: the image builder passes this crun-only flag, and the remote client offers no `--runtime` for builds. Builds therefore run under gVisor too.
- Squid listens on `0.0.0.0:3128` (a socket on `[::]` takes no IPv4 connections inside gVisor).
- **N1 exception (infrastructure, not services):** the internal network's DNS answers only for pods, so the proxy resolves outside names through the DNS of its second network `egress`, created with the fixed subnet 10.89.250.0/24 and named in `squid.conf` as `dns_nameservers 10.89.250.1`. Pods still reach each other by name (`lass-egress:3128`). On Kubernetes this becomes the cluster DNS.
## Open items (to verify on this PC before relying on them)
1. ~~gVisor inside the Podman machine~~: answered above (rootless with ignore-cgroups).
2. ~~Automatic mounting of Windows drives~~: answered above; re-check after every Podman update.
3. ~~`podman kube play` support~~: answered above; Jobs work.
4. Does the egress proxy approach work for the Claude Code CLI's sign-in and API traffic? The proxy works (above); the sign-in needs the user once: `podman exec -it lass-dev-main claude`, then `setup\lass-dev.ps1 -AfterLogin`, which lists any refused endpoints.
5. ~~Rootful gVisor with limits; the machine without passwordless `sudo`; limits for the whole WSL machine~~: answered below (2026-10-17).
6. ~~Resource cap for rootless gVisor containers~~: `.wslconfig` (user decision 2026-10-17), verified.