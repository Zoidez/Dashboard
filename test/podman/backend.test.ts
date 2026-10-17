/**
 * Container backend against the real Podman machine (docs/INFRASTRUCTURE.md O1). Needs the portable
 * Podman (setup\install-podman.ps1), the machine "dashboard" running and set up as option A, and the
 * image docker.io/library/alpine:3.20 in its storage (setup\verify-podman.ps1 pulled it).
 * Run: npm run test:podman. Uses the instance's Podman (Build\data), creates and removes its own jobs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { installedPodman, PodmanBackend, podmanEnv } from "../../src/main/containers/podman.js";

const DATA = resolve(__dirname, "..", "..", "Build", "data");
const opts = installedPodman(DATA);
const ALPINE = "docker.io/library/alpine@sha256:c64c687cbea9300178b30c95835354e34c4e4febc4badfe27102879de0483b5e";

function pm(...args: string[]): string {
  const r = spawnSync(opts!.podmanExe, args, { env: podmanEnv(opts!.podmanDir), encoding: "utf8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

test("a job runs hardened under gVisor, takes files in, gives files out, and is removed by stop", { skip: !opts && "portable Podman not installed", timeout: 240_000 }, async () => {
  const b = new PodmanBackend(opts!);
  const volumesBefore = pm("volume", "ls", "-q").split(/\s+/).filter(Boolean);
  const id = await b.start({
    name: "backend-test",
    image: ALPINE,
    command: ["sh", "-c", [
      "echo kernel=$(uname -r) user=$(id -u)",
      "touch /rootfs-write 2>/dev/null && echo ROOT-WRITABLE || echo root-read-only",
      "wget -q -T 3 -O /dev/null http://1.1.1.1 2>/dev/null && echo NET-REACHED || echo no-network",
      "while [ ! -f /work/in/data.txt ]; do sleep 0.5; done",
      "tr a-z A-Z < /work/in/data.txt > /work/out.txt && echo done",
      "sleep 300",
    ].join("; ")],
    network: "none",
    resources: { cpu: "250m", memory: "128Mi" },
    scratch: ["/work"],
  });
  try {
    assert.equal((await b.status(id)).state, "running");
    await b.copyIn(id, "/work", { "in/data.txt": Buffer.from("hello from the dashboard\n") });
    let out: Record<string, Buffer> = {};
    for (let i = 0; i < 40 && !out["out.txt"]; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { out = await b.copyOut(id, "/work/out.txt"); } catch { /* not written yet */ }
    }
    assert.equal(out["out.txt"]?.toString("utf8"), "HELLO FROM THE DASHBOARD\n");
    const lines: string[] = [];
    for await (const l of b.logs(id)) lines.push(l);
    const log = lines.join("\n");
    console.log("job log:", log);
    assert.match(log, /kernel=\S*gvisor/, "runs under gVisor");
    assert.match(log, /user=10001/);
    assert.match(log, /root-read-only/);
    assert.match(log, /no-network/);
    assert.match(log, /done/);
  } finally {
    await b.stop(id);
  }
  assert.equal((await b.status(id)).state, "gone");
  assert.doesNotMatch(pm("pod", "ls", "--format", "{{.Name}}"), new RegExp(id));
  const left = pm("volume", "ls", "-q").split(/\s+/).filter((v) => v && !volumesBefore.includes(v));
  assert.deepEqual(left, [], "no scratch volume left behind");
});

test("persistent volumes survive stop; copyOut refuses links", { skip: !opts && "portable Podman not installed", timeout: 240_000 }, async () => {
  const b = new PodmanBackend(opts!);
  const id = await b.start({
    name: "backend-pv-test", image: ALPINE, network: "internal", resources: { cpu: "250m", memory: "128Mi" },
    command: ["sh", "-c", "ln -s /etc/passwd /tmp/link; ls -d /claude-config >/dev/null && echo has-volume; sleep 300"],
    volumes: [{ claim: "lass-claude-config", mountPath: "/claude-config" }],
  });
  try {
    await new Promise((r) => setTimeout(r, 2000));
    await assert.rejects(b.copyOut(id, "/tmp/link"), /not a regular file|refused/);
  } finally { await b.stop(id); }
  assert.match(pm("volume", "ls", "-q"), /lass-claude-config/, "the login volume stays");
});
