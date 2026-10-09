/**
 * TESTPLAN A4 through the running app: a card with read+write on one folder uses api.fs normally,
 * then attacks. Every attack must be refused, logged, and leave the outside folder untouched.
 * The file layer itself is tested in depth in test/unit/fs-a4.test.ts and test/race/toctou.test.ts.
 */
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, snapshot, waitFor } from "./helpers";

test("A4: api.fs works inside its folder and refuses every attack through the app", async () => {
  const base = mkdtempSync(join(tmpdir(), "a4e2e-"));
  const S = join(base, "approved"), O = join(base, "outside");
  mkdirSync(S); mkdirSync(O);
  writeFileSync(join(S, "notes.txt"), "hello");
  writeFileSync(join(S, "old.txt"), "old note");
  writeFileSync(join(O, "secret.txt"), "SECRET");
  writeFileSync(join(S, "fake.png"), "PK\x03\x04 zip in disguise");
  symlinkSync(O, join(S, "link"), "junction");
  const inst = makeInstance();
  const J = (...p: string[]) => JSON.stringify(join(...p));
  const DEVICE = `\\\\?\\${O}\\secret.txt`;              // \\?\C:\...\outside\secret.txt
  const UNC = "\\\\localhost\\c$\\Windows\\win.ini";      // \\localhost\c$\Windows\win.ini
  const DOTDOT_INSIDE = `${S}\\sub\\..\\notes.txt`;        // stays inside, but ".." is never accepted

  addCard(inst, {
    id: "file-card",
    permissions: [
      { type: "fs.read", path: S, recursive: true, reason: "reads the notes folder" },
      { type: "fs.write", path: S, recursive: true, reason: "saves notes into the folder" },
      { type: "fs.delete", path: S, recursive: true, reason: "removes old notes from the folder" },
    ],
    ui: `${PRELUDE}
export async function mount(el, api) {
  const r = {};
  r.read = await attempt(() => api.fs.readText(${J(S, "notes.txt")}));
  r.write = await attempt(() => api.fs.writeText(${J(S, "new.md")}, "# written by the card"));
  r.append = await attempt(() => api.fs.appendText(${J(S, "notes.txt")}, " world"));
  r.mkdir = await attempt(() => api.fs.mkdir(${J(S, "sub")}));
  r.list = await attempt(async () => (await api.fs.list(${J(S)})).map((e) => e.path.split("\\\\").pop()).sort().join(","));
  r.stat = await attempt(async () => (await api.fs.stat(${J(S, "notes.txt")})).size);
  const events = [];
  r.watch = await attempt(async () => { await api.fs.watch(${J(S)}, (ev, p) => events.push(ev + ":" + p.split("\\\\").pop())); return "watching"; });
  // attacks
  r.outside = await attempt(() => api.fs.readText(${J(O, "secret.txt")}));
  r.dotdot = await attempt(() => api.fs.readText(${JSON.stringify(S + "\\..\\outside\\secret.txt")}));
  r.junction = await attempt(() => api.fs.readText(${J(S, "link", "secret.txt")}));
  r.junctionWrite = await attempt(() => api.fs.writeText(${J(S, "link", "planted.txt")}, "x"));
  r.device = await attempt(() => api.fs.readText(${JSON.stringify(DEVICE)}));
  r.unc = await attempt(() => api.fs.readText(${JSON.stringify(UNC)}));
  r.dotdotInside = await attempt(() => api.fs.readText(${JSON.stringify(DOTDOT_INSIDE)}));
  r.relative = await attempt(() => api.fs.readText("./data/approvals/file-card.json"));
  r.ads = await attempt(() => api.fs.writeText(${JSON.stringify(S + "\\notes.txt:hidden")}, "x"));
  r.nul = await attempt(() => api.fs.writeText(${J(S, "NUL")}, "x"));
  r.instance = await attempt(() => api.fs.readText(${J(inst, "data", "approvals", "file-card.json")}));
  r.exe = await attempt(() => api.fs.writeBytes(${J(S, "tool.exe")}, new Uint8Array([77, 90])));
  r.fakePng = await attempt(() => api.fs.readBytes(${J(S, "fake.png")}));
  r.remove = await attempt(() => api.fs.remove(${J(S, "old.txt")}));
  r.removeLink = await attempt(() => api.fs.remove(${J(S, "link", "secret.txt")}));
  r.removeOutside = await attempt(() => api.fs.remove(${J(O, "secret.txt")}));
  await report(api, "fs", r);
  await new Promise((res) => setTimeout(res, 2500));   // the test drops a file meanwhile
  await report(api, "events", events);
}`,
  });

  const app = await launch(inst);
  try {
    const r = await waitFor(() => (cardStorage(inst, "file-card")?.results as any)?.fs, "the card's file results", 30_000);
    writeFileSync(join(S, "dropped.txt"), "from outside the card");
    const events = await waitFor(() => (cardStorage(inst, "file-card")?.results as any)?.events, "watch events", 15_000);
    console.log("fs results:", JSON.stringify(r));
    console.log("watch events:", JSON.stringify(events));

    expect(r.read).toMatchObject({ ok: true, v: "hello" });
    for (const k of ["write", "append", "mkdir", "watch"]) expect(r[k].ok, k).toBe(true);
    expect(readFileSync(join(S, "new.md"), "utf8")).toBe("# written by the card");
    expect(readFileSync(join(S, "notes.txt"), "utf8")).toBe("hello world");
    expect(r.list.v).toBe("fake.png,new.md,notes.txt,old.txt,sub");  // the junction is not listed
    expect(r.remove.ok, JSON.stringify(r.remove)).toBe(true);
    expect(existsSync(join(S, "old.txt"))).toBe(false);
    expect(r.stat.v).toBe("11");
    expect(events).toContain("add:dropped.txt");

    const expectCode: Record<string, string> = {
      outside: "PermissionDenied", dotdot: "InvalidArgument", junction: "PermissionDenied", junctionWrite: "PermissionDenied",
      device: "InvalidArgument", unc: "InvalidArgument", dotdotInside: "InvalidArgument", relative: "InvalidArgument", ads: "InvalidArgument", nul: "InvalidArgument",
      instance: "PermissionDenied", exe: "PermissionDenied", fakePng: "InvalidArgument", removeLink: "PermissionDenied", removeOutside: "PermissionDenied",
    };
    for (const [k, code] of Object.entries(expectCode)) expect(r[k], k).toMatchObject({ ok: false, code });
    expect(existsSync(join(O, "planted.txt"))).toBe(false);
    expect(existsSync(join(S, "tool.exe"))).toBe(false);
    expect(readFileSync(join(O, "secret.txt"), "utf8")).toBe("SECRET");

    const snap = await snapshot(app);
    const mine = snap.audit.filter((e) => e.cardId === "file-card");
    expect(mine.filter((e) => e.kind === "fs").map((e) => e.detail.split(" ")[0])).toEqual(expect.arrayContaining(["writeText", "appendText", "mkdir", "remove"]));
    expect(mine.some((e) => e.kind === "denied" && e.detail.includes("[check: verified]"))).toBe(true);

    // The file helper is its own process, not the main process and not a card's.
    const { helperPid, procs } = await app.evaluate(({ app }) => ({
      helperPid: (globalThis as any).__dashboard.files.pid as number,
      procs: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })),
    }));
    expect(procs.find((p) => p.pid === helperPid)?.type, JSON.stringify(procs)).toBe("Utility");
    expect(helperPid).not.toBe(snap.mainPid);
    expect(snap.running.map((c) => c.pid)).not.toContain(helperPid);

    // Stop drops the watch with the session.
    const live = await app.evaluate(() => {
      const d = (globalThis as any).__dashboard;
      const s = d.host.cards.get("file-card").broker;
      const before = s.watches.size;
      d.host.stop("file-card", "stopped by test");
      return { before, after: s.watches.size, resources: s.resources.size };
    });
    expect(live).toEqual({ before: 1, after: 0, resources: 0 });
  } finally {
    await app.close();
  }
});
