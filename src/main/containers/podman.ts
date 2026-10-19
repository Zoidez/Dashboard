/**
 * The Podman backend of the container backend (docs/INFRASTRUCTURE.md, O1). Runs podman.exe directly
 * (never a shell) with Podman's home, config and data under Build\data\podman, as podman.cmd does:
 * Podman 6 keeps machine config under USERPROFILE/APPDATA whatever XDG_CONFIG_HOME says.
 * Jobs are Pods from `podman kube play`; their manifests are kept in Build\data\podman\jobs\<id>.yaml
 * until the job is stopped. Files move with `podman exec ... tar`, so job images must contain tar.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ContainerBackend, FileSet, JobId, JobSpec, JobStatus, NetworkProfile } from "./backend.js";
import { JOB_USER, NETWORKS, PROXIES, renderJob, toYaml, validateSpec } from "./render.js";
import { readTar, safeRelPath, writeTar } from "./tar.js";

export interface RunResult { code: number | null; stdout: Buffer; stderr: string }
/** Runs podman with arguments and optional stdin; injectable for tests. */
export type Runner = (args: string[], opts?: { stdin?: Buffer; timeoutMs?: number }) => Promise<RunResult>;

const ID = /^job-[a-z][a-z0-9-]{0,30}[a-z0-9]-[0-9a-f]{8}$/;
/** The Podman machine set up by setup\verify-podman.ps1 (option A, INFRASTRUCTURE.md). */
export const MACHINE = "dashboard";
/** Networks that must have no route out: a job on them reaches the outside only through a proxy. */
export const INTERNAL_NETWORKS = ["lass-internal", "lass-fix"];

const MACHINE_HINT = "Build\\data\\podman\\podman.cmd";
/** A problem only the user can solve (shown as a step in the LASS bar). */
export class UserStepError extends Error {}

export interface PodmanOptions {
  /** Build\data\podman */
  podmanDir: string;
  /** Build\data\vendor\podman\<version>\podman.exe */
  podmanExe: string;
  run?: Runner;
}

/** The environment podman.exe runs with: everything of Podman's under Build\data\podman (and nothing else of the user's). */
export function podmanEnv(podmanDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(podmanDir, "home");
  return {
    SystemRoot: base.SystemRoot, windir: base.windir, SystemDrive: base.SystemDrive, ComSpec: base.ComSpec,
    PATH: base.PATH, PATHEXT: base.PATHEXT, TEMP: join(home, "AppData", "Local", "Temp"), TMP: join(home, "AppData", "Local", "Temp"),
    USERNAME: base.USERNAME, USERDOMAIN: base.USERDOMAIN, COMPUTERNAME: base.COMPUTERNAME, NUMBER_OF_PROCESSORS: base.NUMBER_OF_PROCESSORS,
    USERPROFILE: home, HOME: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(podmanDir, "config"), XDG_DATA_HOME: join(podmanDir, "data"),
    CONTAINERS_CONF: join(podmanDir, "containers.conf"), CONTAINERS_MACHINE_PROVIDER: "wsl",
  };
}

/** Finds the installed podman.exe from Build\data\vendor\podman\install.json (setup\install-podman.ps1). */
export function installedPodman(dataDir: string): PodmanOptions | null {
  try {
    const rec = JSON.parse(readFileSync(join(dataDir, "vendor", "podman", "install.json"), "utf8")) as { version?: string };
    if (!rec.version || !/^\d+\.\d+\.\d+$/.test(rec.version)) return null;
    const exe = join(dataDir, "vendor", "podman", rec.version, "podman.exe");
    return existsSync(exe) ? { podmanDir: join(dataDir, "podman"), podmanExe: exe } : null;
  } catch { return null; }
}

function defaultRunner(exe: string, env: NodeJS.ProcessEnv): Runner {
  return (args, opts = {}) => new Promise((resolve) => {
    mkdirSync(env.TEMP!, { recursive: true });
    const child = spawn(exe, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = []; let err = "";
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => { if (err.length < 20_000) err += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? Buffer.alloc(0));
  });
}

export class PodmanBackend implements ContainerBackend {
  private readonly run: Runner;
  private readonly jobsDir: string;
  /** Scratch mounts per job, for copyIn checks. */
  private readonly scratch = new Map<JobId, string[]>();

  constructor(private readonly o: PodmanOptions) {
    const env = podmanEnv(o.podmanDir);
    this.run = o.run ?? defaultRunner(o.podmanExe, env);
    this.jobsDir = join(o.podmanDir, "jobs");
  }

  private async pm(args: string[], opts?: { stdin?: Buffer; timeoutMs?: number }): Promise<Buffer> {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new Error(`podman ${args[0]} ${args[1] ?? ""} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 600)}`);
    return r.stdout;
  }

  private check(id: JobId): void { if (!ID.test(id)) throw new Error("unknown job id"); }
  private yamlOf(id: JobId): string { return join(this.jobsDir, `${id}.yaml`); }
  private ctr(id: JobId): string { return `${id}-main`; }

  /** Starts the machine if it is stopped, checks that the internal networks are internal, and starts the
   *  proxy pods the given profiles need (all set up once by the user with setup\lass-dev.ps1). */
  async prepare(profiles: NetworkProfile[]): Promise<void> {
    const m = await this.run(["machine", "inspect", MACHINE, "--format", "{{.State}}"]);
    if (m.code !== 0) throw new UserStepError(`The Podman machine "${MACHINE}" is not set up: run setup\\verify-podman.ps1 once (INFRASTRUCTURE.md).`);
    if (m.stdout.toString("utf8").trim().toLowerCase() !== "running") await this.pm(["machine", "start", MACHINE], { timeoutMs: 300_000 });
    for (const p of new Set(profiles)) {
      for (const net of NETWORKS[p].filter((n) => INTERNAL_NETWORKS.includes(n))) {
        const r = await this.run(["network", "inspect", net, "--format", "{{.Internal}}"]);
        if (r.code !== 0) throw new UserStepError(`The container network ${net} is not set up: run setup\\lass-dev.ps1 once in PowerShell.`);
        // A job on a network with a route out could bypass its proxy: refuse rather than run.
        if (r.stdout.toString("utf8").trim() !== "true") throw new Error(`the container network ${net} is not internal (it has a route out); refusing to start jobs on it`);
      }
      const proxy = PROXIES[p];
      if (!proxy) continue;
      const r = await this.run(["pod", "inspect", proxy.pod, "--format", "{{.State}}"]);
      if (r.code !== 0) throw new UserStepError(`The proxy ${proxy.pod} is not set up: run setup\\lass-dev.ps1 once in PowerShell (it builds the container images and starts the proxies).`);
      if (r.stdout.toString("utf8").trim().toLowerCase() !== "running") await this.pm(["pod", "start", proxy.pod], { timeoutMs: 120_000 });
      // Running is not enough: the proxy must accept connections (2026-10-19: Squid in a restart loop,
      // the pod "Running", every request refused). Up to 30 s for a fresh start.
      let listening = false;
      for (let i = 0; i < 15 && !listening; i++) {
        listening = (await this.run(["exec", `${proxy.pod}-proxy`, "nc", "-z", "127.0.0.1", "3128"], { timeoutMs: 15_000 })).code === 0;
        if (!listening) await new Promise((res) => setTimeout(res, this.o.run ? 1 : 2000));
      }
      if (!listening) throw new UserStepError(`The proxy ${proxy.pod} runs but does not accept connections (its log: ${MACHINE_HINT} logs ${proxy.pod}-proxy). Run setup\\lass-dev.ps1 once in PowerShell to rebuild and restart it.`);
    }
  }

  /** The newest local image of a recipe (localhost/<name>:<git commit>), preferring builds from committed recipes. */
  async latestImage(name: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error("bad image name");
    const out = await this.pm(["images", "--format", "json", "--filter", `reference=localhost/${name}`]);
    let list: Array<{ Names?: string[]; Created?: number }> = [];
    try { list = JSON.parse(out.toString("utf8") || "[]") as typeof list; } catch { /* none */ }
    const refs = list.flatMap((i) => (i.Names ?? []).map((n) => ({ n, t: Number(i.Created) || 0 })))
      .filter((r) => new RegExp(`^localhost/${name}:[0-9a-f]{12}(-dirty)?$`).test(r.n))
      .sort((a, b) => Number(a.n.endsWith("-dirty")) - Number(b.n.endsWith("-dirty")) || b.t - a.t);
    if (!refs.length) throw new UserStepError(`The container image ${name} is not built: run setup\\lass-dev.ps1 once in PowerShell.`);
    return refs[0].n;
  }

  async start(spec: JobSpec): Promise<JobId> {
    validateSpec(spec);
    const needed = PROXIES[spec.network];
    if (needed) {
      const proxy = await this.run(["pod", "exists", needed.pod]);
      if (proxy.code !== 0) throw new Error(`the proxy (pod ${needed.pod}) is not running`);
    }
    const id = `job-${spec.name}-${randomBytes(4).toString("hex")}`;
    mkdirSync(this.jobsDir, { recursive: true });
    const file = this.yamlOf(id);
    writeFileSync(file, toYaml(renderJob(id, spec)));
    const nets = NETWORKS[spec.network].flatMap((n) => ["--network", n]);
    try {
      await this.pm(["kube", "play", ...nets, file], { timeoutMs: 300_000 });
    } catch (e) {
      await this.run(["kube", "down", file]);
      rmSync(file, { force: true });
      throw e;
    }
    this.scratch.set(id, ["/tmp", ...(spec.scratch ?? [])]);
    return id;
  }

  async status(id: JobId): Promise<JobStatus> {
    this.check(id);
    const r = await this.run(["inspect", this.ctr(id), "--format", "{{.State.Status}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}"]);
    if (r.code !== 0) return { state: "gone" };
    const [st, code, started, finished] = r.stdout.toString("utf8").trim().split("|");
    const state = st === "running" ? "running" : st === "exited" || st === "stopped" ? "exited" : "starting";
    return { state, ...(state === "exited" ? { exitCode: Number(code) } : {}), startedAt: started, ...(state === "exited" ? { finishedAt: finished } : {}) };
  }

  async *logs(id: JobId): AsyncIterable<string> {
    this.check(id);
    const r = await this.run(["logs", this.ctr(id)]);
    if (r.code !== 0) throw new Error(`no logs for ${id}: ${r.stderr.trim().slice(0, 300)}`);
    // podman logs writes the container's stdout and stderr; both are the job's log (L1).
    for (const line of (r.stdout.toString("utf8") + r.stderr).split(/\r?\n/)) if (line) yield line;
  }

  async copyIn(id: JobId, dir: string, files: FileSet): Promise<void> {
    this.check(id);
    const norm = posix.normalize(dir);
    const mounts = this.scratch.get(id) ?? [];
    if (norm !== dir || !mounts.some((m) => norm === m || norm.startsWith(`${m}/`))) throw new Error(`copyIn: ${dir} is not inside a scratch folder of the job`);
    for (const p of Object.keys(files)) if (!safeRelPath(p)) throw new Error(`copyIn: unsafe path ${JSON.stringify(p).slice(0, 80)}`);
    // Through the container itself: `podman cp` cannot see into a gVisor sandbox (it works from the host
    // side). The archive is built here, so the container's tar only unpacks known, safe paths.
    await this.pm(["exec", "-i", this.ctr(id), "tar", "-x", "-f", "-", "-C", dir], { stdin: writeTar(files, JOB_USER), timeoutMs: 300_000 });
  }

  async copyOut(id: JobId, path: string): Promise<FileSet> {
    this.check(id);
    if (!path.startsWith("/") || posix.normalize(path) !== path || path.includes("\0")) throw new Error("copyOut: absolute, normalized path required");
    // The container's tar writes the archive; it is untrusted, so readTar keeps regular files with safe names only.
    const parent = posix.dirname(path), base = posix.basename(path);
    if (!base || base === "/") throw new Error("copyOut: name a file or folder, not /");
    return readTar(await this.pm(["exec", this.ctr(id), "tar", "-c", "-f", "-", "-C", parent, base], { timeoutMs: 300_000 }));
  }

  async stop(id: JobId): Promise<void> {
    this.check(id);
    const file = this.yamlOf(id);
    // kube down without --force: the pod, its containers and its scratch (anonymous) volumes go;
    // persistent volumes (PersistentVolumeClaims) stay.
    if (existsSync(file)) await this.run(["kube", "down", file], { timeoutMs: 120_000 });
    await this.run(["pod", "rm", "--force", "--ignore", id]);
    this.scratch.delete(id);
    rmSync(file, { force: true });
  }
}
