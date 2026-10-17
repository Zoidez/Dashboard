/**
 * Container backend (docs/INFRASTRUCTURE.md O1, D1, D4, X2, X3, N2), without Podman: the manifest is
 * hardened whatever the spec says, loose specs are refused, tar handling refuses unsafe entries, and
 * the backend's podman calls are what they should be (fake runner).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSpec } from "../../src/main/containers/backend.js";
import { renderJob, toYaml, validateSpec, SpecError } from "../../src/main/containers/render.js";
import { readTar, safeRelPath, writeTar } from "../../src/main/containers/tar.js";
import { PodmanBackend, podmanEnv, type Runner } from "../../src/main/containers/podman.js";

const base = (): JobSpec => ({ name: "fix-run", image: "localhost/dashboard-lass-dev:463c2f8e3de7", network: "egress", resources: { cpu: "500m", memory: "1Gi" }, scratch: ["/work", "/home/dev"], volumes: [{ claim: "lass-claude-config", mountPath: "/claude-config" }] });

test("the pod is hardened and mounts nothing from the host", () => {
  const docs = renderJob("job-fix-run-0a1b2c3d", base()) as any[];
  assert.deepEqual(docs.map((d) => d.kind), ["PersistentVolumeClaim", "Pod"]);
  const pod = docs[1], c = pod.spec.containers[0];
  assert.deepEqual(c.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.deepEqual(c.resources, { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "500m", memory: "1Gi" } });
  assert.ok(pod.spec.volumes.every((v: any) => Object.keys(v).sort().join() === "emptyDir,name" || Object.keys(v).sort().join() === "name,persistentVolumeClaim"), "only emptyDir and PVC volumes");
  assert.deepEqual(c.volumeMounts.map((m: any) => m.mountPath), ["/tmp", "/work", "/home/dev", "/claude-config"]);
  assert.deepEqual(c.env.filter((e: any) => /proxy/i.test(e.name)).map((e: any) => e.value), ["http://lass-egress:3128", "http://lass-egress:3128", "localhost,127.0.0.1"]);
  assert.doesNotMatch(toYaml(docs), /hostPath|privileged|hostNetwork|hostPID|hostIPC/);
});

test("no proxy settings without the egress profile", () => {
  const s = { ...base(), network: "internal" as const };
  const c = (renderJob("job-fix-run-0a1b2c3d", s) as any[])[1].spec.containers[0];
  assert.equal(c.env.length, 0);
});

test("loose specs are refused", () => {
  const cases: Array<[string, (s: any) => void]> = [
    ["upper-case name", (s) => { s.name = "Fix"; }],
    ["image by tag from a registry", (s) => { s.image = "docker.io/library/alpine:3.20"; }],
    ["image with a shell trick", (s) => { s.image = "localhost/x:1;rm -rf /"; }],
    ["host network profile", (s) => { s.network = "host"; }],
    ["proxy set by hand", (s) => { s.env = { HTTPS_PROXY: "http://evil:1" }; }],
    ["bad env name", (s) => { s.env = { "A B": "x" }; }],
    ["mount into /etc", (s) => { s.scratch = ["/etc/x"]; }],
    ["mount with ..", (s) => { s.scratch = ["/work/../etc"]; }],
    ["unknown persistent volume", (s) => { s.volumes = [{ claim: "user-home", mountPath: "/data" }]; }],
    ["persistent volume on /tmp", (s) => { s.volumes = [{ claim: "lass-claude-config", mountPath: "/tmp" }]; }],
    ["repeated mount", (s) => { s.scratch = ["/work", "/work"]; }],
    ["memory without unit", (s) => { s.resources.memory = "1000000"; }],
    ["command not a list", (s) => { s.command = "sh -c x"; }],
  ];
  for (const [why, mutate] of cases) {
    const s = JSON.parse(JSON.stringify(base()));
    mutate(s);
    assert.throws(() => validateSpec(s), SpecError, why);
  }
  validateSpec({ ...base(), image: "docker.io/library/alpine@sha256:" + "a".repeat(64) });
});

test("tar: round trip, folders, and unsafe entries refused", () => {
  const files = { "a.txt": Buffer.from("A"), "dir/sub/b.bin": Buffer.alloc(1000, 7), [`${"d".repeat(120)}/long-name.txt`]: Buffer.from("L") };
  assert.deepEqual(readTar(writeTar(files, 10001)), files);
  for (const bad of ["../x", "/etc/passwd", "a/../../b", "a\\b", "", "a//b", "./a"]) assert.equal(safeRelPath(bad), false, bad);
  assert.throws(() => writeTar({ "../x": Buffer.from("x") }, 1), /unsafe/);
  // A symlink entry is refused when reading.
  const t = writeTar({ "link": Buffer.alloc(0) }, 1);
  t[156] = "2".charCodeAt(0);
  let sum = 0; t.fill(0x20, 148, 156); for (let i = 0; i < 512; i++) sum += t[i];
  t.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  assert.throws(() => readTar(t), /not a regular file/);
  assert.throws(() => readTar(writeTar({ big: Buffer.alloc(2000) }, 1), { maxBytes: 1000, maxFiles: 10 }), /more data/);
});

test("podman runs with its home under Build\\data\\podman, and only selected variables", () => {
  const env = podmanEnv("D:\\B\\data\\podman", { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\x", SECRET_TOKEN: "s", SystemRoot: "C:\\Windows" });
  assert.equal(env.USERPROFILE, "D:\\B\\data\\podman\\home");
  assert.equal(env.APPDATA, "D:\\B\\data\\podman\\home\\AppData\\Roaming");
  assert.equal(env.CONTAINERS_CONF, "D:\\B\\data\\podman\\containers.conf");
  assert.equal(env.SECRET_TOKEN, undefined, "nothing else from the user's environment");
});

test("backend: kube play with the profile's networks, copies by tar, stop removes the pod", async () => {
  const calls: Array<{ args: string[]; stdin?: Buffer }> = [];
  const run: Runner = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin });
    if (args[0] === "exec" && args.includes("-c")) return { code: 0, stdout: writeTar({ "out.txt": Buffer.from("DONE") }, 0), stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: Buffer.from("exited|0|2026-10-17T10:00:00Z|2026-10-17T10:01:00Z\n"), stderr: "" };
    return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  const b = new PodmanBackend({ podmanDir: mkdtempSync(join(tmpdir(), "pm-")), podmanExe: "podman.exe", run });
  const id = await b.start({ ...base(), network: "internal", volumes: [] });
  assert.match(id, /^job-fix-run-[0-9a-f]{8}$/);
  const play = calls.find((c) => c.args[0] === "kube" && c.args[1] === "play")!;
  assert.deepEqual(play.args.slice(2, 4), ["--network", "lass-internal"]);
  await b.copyIn(id, "/work", { "in.txt": Buffer.from("hi") });
  const cp = calls.find((c) => c.args[0] === "exec" && c.args.includes("-x"))!;
  assert.deepEqual(cp.args, ["exec", "-i", `${id}-main`, "tar", "-x", "-f", "-", "-C", "/work"]);
  assert.deepEqual(readTar(cp.stdin!), { "in.txt": Buffer.from("hi") });
  await assert.rejects(b.copyIn(id, "/etc", { x: Buffer.from("x") }), /not inside a scratch folder/);
  await assert.rejects(b.copyIn(id, "/work/../etc", { x: Buffer.from("x") }), /not inside a scratch folder/);
  assert.deepEqual(await b.copyOut(id, "/work/out.txt"), { "out.txt": Buffer.from("DONE") });
  assert.deepEqual(calls.find((c) => c.args[0] === "exec" && c.args.includes("-c"))!.args, ["exec", `${id}-main`, "tar", "-c", "-f", "-", "-C", "/work", "out.txt"]);
  assert.deepEqual(await b.status(id), { state: "exited", exitCode: 0, startedAt: "2026-10-17T10:00:00Z", finishedAt: "2026-10-17T10:01:00Z" });
  await b.stop(id);
  assert.ok(calls.some((c) => c.args[0] === "kube" && c.args[1] === "down"));
  await assert.rejects(b.status("job-x;rm"), /unknown job id/);
  // The egress profile needs the proxy pod.
  const noProxy = new PodmanBackend({ podmanDir: mkdtempSync(join(tmpdir(), "pm-")), podmanExe: "podman.exe", run: async (a) => ({ code: a[0] === "pod" ? 1 : 0, stdout: Buffer.alloc(0), stderr: "" }) });
  await assert.rejects(noProxy.start(base()), /egress proxy/);
});
