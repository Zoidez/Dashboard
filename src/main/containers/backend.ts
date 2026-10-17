/**
 * The container backend (docs/INFRASTRUCTURE.md, rule O1): the only code in the Dashboard that knows
 * which container platform runs a job. The Podman backend (podman.ts) renders a JobSpec into Kubernetes
 * YAML and runs it with `podman kube play` / `podman kube down`; a Kubernetes backend would create the
 * same objects through the Kubernetes API. Nothing outside this folder knows which one is in use.
 *
 * What a job can and cannot ask for is fixed here, not in the spec: every container runs as user 10001
 * with a read-only root, all capabilities dropped and no privilege escalation (X2); volumes are only
 * scratch folders (emptyDir) and the persistent volumes named in PERSISTENT_VOLUMES; nothing from the
 * host is ever mounted (X3); networks come only from the three profiles below (N1, N2).
 */

/** Network profiles. none: no network at all. internal: lass-internal only (no route out).
 *  egress: lass-internal, with HTTPS_PROXY pointing at the egress proxy (its allowlist decides). */
export type NetworkProfile = "none" | "internal" | "egress";

/** Persistent volumes a job may mount, by claim name (S1, S4). Anything else is refused. */
export const PERSISTENT_VOLUMES = ["lass-claude-config"] as const;
export type PersistentVolume = (typeof PERSISTENT_VOLUMES)[number];

export interface JobSpec {
  /** Short name; the job id is "job-<name>-<random>". Lower case letters, digits and dashes. */
  name: string;
  /** Image reference: a local build (localhost/...) or a reference pinned by digest (I1). The image must
   *  contain tar (files are copied in and out through it). */
  image: string;
  /** Command and arguments; the image's own command when absent. Passed as a list, never through a shell. */
  command?: string[];
  /** Plain configuration only (S2). Secrets never go here (S3). */
  env?: Record<string, string>;
  network: NetworkProfile;
  /** Requests and limits (D4). Kubernetes quantities, e.g. cpu "500m", memory "1Gi". */
  resources: { cpu: string; memory: string; cpuLimit?: string; memoryLimit?: string };
  /** Writable scratch folders (emptyDir), removed with the job. /tmp is always one. */
  scratch?: string[];
  /** Persistent volumes from PERSISTENT_VOLUMES, with their mount paths. */
  volumes?: Array<{ claim: PersistentVolume; mountPath: string }>;
}

export type JobId = string;

export interface JobStatus {
  state: "starting" | "running" | "exited" | "gone";
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
}

/** Files by relative path (forward slashes, no "..", no absolute paths). */
export type FileSet = Record<string, Buffer>;

export interface ContainerBackend {
  start(spec: JobSpec): Promise<JobId>;
  status(id: JobId): Promise<JobStatus>;
  logs(id: JobId): AsyncIterable<string>;
  /** Copies files into a scratch folder of the job (dir must be one of its scratch mounts or below it). */
  copyIn(id: JobId, dir: string, files: FileSet): Promise<void>;
  /** Copies a file or folder out of the job; regular files only, size-limited. */
  copyOut(id: JobId, path: string): Promise<FileSet>;
  /** Always removes the job's container and its scratch volumes; persistent volumes stay. */
  stop(id: JobId): Promise<void>;
}
