/**
 * JobSpec -> Kubernetes objects (docs/INFRASTRUCTURE.md D1, D4, X2, X3). The objects are written as
 * JSON documents (valid YAML), so no value from a spec can change the structure of the manifest.
 * Every security setting is fixed here; a spec cannot switch one off.
 */
import { PERSISTENT_VOLUMES, type JobSpec } from "./backend.js";

export const JOB_USER = 10001;
export const EGRESS_PROXY = "http://lass-egress:3128";
export const API_PROXY = "http://lass-egress-api:3128";
export const NETWORKS: Record<JobSpec["network"], string[]> = { none: ["none"], internal: ["lass-internal"], egress: ["lass-internal"], anthropic: ["lass-fix"] };
/** The proxy pod a profile depends on, and its address. */
export const PROXIES: Partial<Record<JobSpec["network"], { pod: string; url: string }>> = {
  egress: { pod: "lass-egress", url: EGRESS_PROXY },
  anthropic: { pod: "lass-egress-api", url: API_PROXY },
};

const NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const IMAGE = /^(localhost\/[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9._-]{1,128}|[a-z0-9][a-z0-9.-]{0,252}(:\d{1,5})?\/[a-z0-9][a-z0-9._/-]{0,255}@sha256:[0-9a-f]{64})$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const QUANTITY_CPU = /^(\d{1,4}m|\d{1,3}(\.\d{1,3})?)$/;
const QUANTITY_MEM = /^\d{1,6}(Mi|Gi)$/;
const MOUNT = /^\/[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,4}$/;
const RESERVED_ENV = new Set(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY"]);
const FORBIDDEN_MOUNTS = [/^\/(proc|sys|dev|etc|usr|bin|sbin|lib|lib64|boot|run|var\/run)(\/|$)/];

export class SpecError extends Error {}

/** Checks a spec strictly; throws SpecError with the reason. */
export function validateSpec(s: JobSpec): void {
  const no = (why: string): never => { throw new SpecError(`job spec: ${why}`); };
  if (!s || typeof s !== "object") no("not an object");
  if (typeof s.name !== "string" || !NAME.test(s.name)) no("name: lower case letters, digits and dashes, 2-32 characters");
  if (typeof s.image !== "string" || !IMAGE.test(s.image)) no("image: localhost/<name>:<tag> or a reference pinned by @sha256 digest");
  if (s.command !== undefined && (!Array.isArray(s.command) || s.command.length > 64 || s.command.some((c) => typeof c !== "string" || c.length > 4096 || c.includes("\0")))) no("command: up to 64 strings");
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (!ENV_KEY.test(k)) no(`env name ${JSON.stringify(k).slice(0, 40)}`);
    if (RESERVED_ENV.has(k)) no(`env ${k} is set by the network profile`);
    if (typeof v !== "string" || v.length > 4096 || v.includes("\0")) no(`env ${k}: a string up to 4096 characters`);
  }
  if (!["none", "internal", "egress", "anthropic"].includes(s.network)) no("network: none, internal, egress or anthropic");
  const r = s.resources;
  if (!r || !QUANTITY_CPU.test(r.cpu) || !QUANTITY_MEM.test(r.memory)) no("resources: cpu like \"500m\" or \"2\", memory like \"512Mi\" or \"2Gi\"");
  if (r.cpuLimit !== undefined && !QUANTITY_CPU.test(r.cpuLimit)) no("resources.cpuLimit");
  if (r.memoryLimit !== undefined && !QUANTITY_MEM.test(r.memoryLimit)) no("resources.memoryLimit");
  const mounts = [...(s.scratch ?? []), ...(s.volumes ?? []).map((v) => v.mountPath)];
  for (const m of mounts) if (typeof m !== "string" || !MOUNT.test(m) || FORBIDDEN_MOUNTS.some((f) => f.test(m))) no(`mount path ${JSON.stringify(m).slice(0, 60)}`);
  if (new Set(mounts).size !== mounts.length) no("mount paths repeat");
  if ((s.volumes ?? []).some((v) => v.mountPath === "/tmp")) no("/tmp is always a scratch folder");
  for (const v of s.volumes ?? []) if (!(PERSISTENT_VOLUMES as readonly string[]).includes(v.claim)) no(`persistent volume ${JSON.stringify(v.claim).slice(0, 40)} is not allowed`);
}

/** The Kubernetes documents for one job (a PersistentVolumeClaim per persistent volume, then the Pod). */
export function renderJob(id: string, s: JobSpec): object[] {
  validateSpec(s);
  const scratch = [...new Set(["/tmp", ...(s.scratch ?? [])])];
  const env = Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value }));
  const proxy = PROXIES[s.network];
  if (proxy) for (const name of ["HTTPS_PROXY", "https_proxy"]) env.push({ name, value: proxy.url });
  if (proxy) env.push({ name: "NO_PROXY", value: "localhost,127.0.0.1" });
  const volumes: object[] = [], mounts: object[] = [];
  scratch.forEach((m, i) => { volumes.push({ name: `scratch-${i}`, emptyDir: {} }); mounts.push({ name: `scratch-${i}`, mountPath: m }); });
  (s.volumes ?? []).forEach((v, i) => { volumes.push({ name: `data-${i}`, persistentVolumeClaim: { claimName: v.claim } }); mounts.push({ name: `data-${i}`, mountPath: v.mountPath }); });
  const claims = [...new Set((s.volumes ?? []).map((v) => v.claim))].map((claim) => ({
    apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: claim },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
  }));
  const pod = {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: id, labels: { "dashboard-job": s.name } },
    spec: {
      restartPolicy: "Never",
      containers: [{
        name: "main",
        image: s.image,
        ...(s.command ? { command: s.command } : {}),
        env,
        resources: {
          requests: { cpu: s.resources.cpu, memory: s.resources.memory },
          limits: { cpu: s.resources.cpuLimit ?? s.resources.cpu, memory: s.resources.memoryLimit ?? s.resources.memory },
        },
        securityContext: {
          runAsNonRoot: true, runAsUser: JOB_USER, runAsGroup: JOB_USER,
          readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] },
        },
        volumeMounts: mounts,
      }],
      volumes,
    },
  };
  return [...claims, pod];
}

/** The documents as one YAML stream (JSON documents separated by ---). */
export function toYaml(docs: object[]): string {
  return docs.map((d) => JSON.stringify(d, null, 2)).join("\n---\n") + "\n";
}
