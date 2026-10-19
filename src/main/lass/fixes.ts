/**
 * LASS phase 4 (docs/LASS.md 8, 9a): the fix, from "identified" to "verifying". Every step that changes
 * something is the user's click, in the LASS bar:
 *   Start the fix      -> fix run in the sealed container (fix-run.ts); the host reviews the patch (patch.ts)
 *   Test on this PC    -> after the user saw the patch (and confirmed the red files): fix-test.ts
 *   Install            -> the tested build becomes pending; the launcher restarts into it and rolls back
 *                         if it does not come up with a matching security-test record
 *   Fixed? Yes / No    -> on the fixed build; a successful request for the same card also answers it
 * Reject at any point before Install closes the investigation and removes the worktree and branch.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityLog } from "./activity.js";
import type { DailyBudget } from "./budget.js";
import { FixRunCancelled, runFix, type FixBrief, type FixRunDeps } from "./fix-run.js";
import { cleanUpFix, testFix, type FixTestDeps } from "./fix-test.js";
import type { Investigation, Investigations } from "./investigations.js";
import { reviewPatch } from "./patch.js";
import type { LassFixView } from "../../shared/ui-state.js";

export interface FixesDeps {
  investigations: Investigations;
  budget: DailyBudget;
  activity: ActivityLog;
  /** Build/data/lass */
  lassDir: string;
  /** Build */
  root: string;
  /** The project folder with .git, or null (fix runs unavailable, with the reason). */
  repo: string | null;
  /** The container side, or the reason it is unavailable. */
  container: Omit<FixRunDeps, "outDir" | "progress" | "bundle"> | { unavailable: string };
  brief: (inv: Investigation) => FixBrief;
  /** git bundle of HEAD (default: git bundle create). */
  bundle?: (file: string) => Promise<{ data: Buffer; base: string }>;
  /** Replaces the Windows test (tests). */
  test?: (d: FixTestDeps, signal: AbortSignal) => ReturnType<typeof testFix>;
  cleanUp?: typeof cleanUpFix;
  setPending: (build: string) => void;
  restart: () => void;
  /** The build that is current (Build\data\current-build.json), and rollouts the launcher recorded. */
  currentBuild: () => string | undefined;
  changed: () => void;
}

export type FixView = LassFixView;

export class LassFixes {
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly d: FixesDeps) {
    // Cancel investigation (the New card's button or the bar's) stops a running step and cleans up.
    d.investigations.on("change", (inv: Investigation) => {
      if (inv.state === "closed" && this.aborts.has(inv.id)) this.aborts.get(inv.id)!.abort();
    });
  }

  private dir(id: string): string { return join(this.d.lassDir, "fixes", id); }
  private log(id: string): string { return join(this.dir(id), "windows.log"); }

  unavailable(): string | undefined {
    if (!this.d.repo) return "the Dashboard's project folder (with its git repository) is not next to this instance, so LASS has no source to fix";
    if ("unavailable" in this.d.container) return this.d.container.unavailable;
    return undefined;
  }

  view(): FixView | null {
    const inv = this.d.investigations.list().find((i) => i.state === "identified" || i.state === "fixing" || i.state === "verifying");
    if (!inv) return null;
    const f = inv.fix ?? {};
    return {
      id: inv.id, state: inv.state as FixView["state"], left: this.d.budget.left("fix"),
      ...(this.unavailable() ? { unavailable: this.unavailable() } : {}),
      ...(inv.summary ? { summary: inv.summary } : {}), kind: inv.category === "change-request" ? "change" : "fault",
      ...(f.stage ? { stage: f.stage } : {}), ...(f.progress ? { progress: f.progress } : {}), ...(f.error ? { error: f.error } : {}),
      ...(f.files ? { files: f.files, refused: f.refused ?? [], added: f.added, removed: f.removed, checks: f.checks } : {}),
      ...(f.summary ? { fixSummary: f.summary } : {}), ...(f.build ? { build: f.build } : {}), ...(f.branch ? { branch: f.branch } : {}),
    };
  }

  /** The patch text, for "Show changes". */
  patch(id: string): string {
    const f = join(this.dir(id), "fix.patch");
    return existsSync(f) ? readFileSync(f, "utf8").slice(0, 2 * 1024 * 1024) : "";
  }

  private async defaultBundle(file: string): Promise<{ data: Buffer; base: string }> {
    const { execFileSync } = await import("node:child_process");
    const repo = this.d.repo!;
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { windowsHide: true }).toString("utf8").trim();
    execFileSync("git", ["-C", repo, "bundle", "create", file, "HEAD"], { windowsHide: true, stdio: "ignore" });
    return { data: readFileSync(file), base };
  }

  /** Start the fix (the user's click). Returns a reason when it cannot start. */
  start(id: string): string | null {
    const inv = this.d.investigations.get(id);
    if (!inv || inv.state !== "identified") return "this investigation is not waiting for a fix";
    const why = this.unavailable();
    if (why) return why;
    if (!this.d.budget.take("fix")) return "today's 2 fix runs are used up; LASS can try again tomorrow";
    const c = this.d.container as Omit<FixRunDeps, "outDir" | "progress" | "bundle">;
    const ac = new AbortController();
    this.aborts.set(id, ac);
    const out = this.dir(id);
    mkdirSync(out, { recursive: true });
    this.d.investigations.setFix(id, { stage: "container", progress: "starting", error: undefined, runs: (inv.fix?.runs ?? 0) + 1 }, "fix run started by the user");
    this.d.activity.write("lass", "fix.start", id);
    void (async () => {
      try {
        const brief = this.d.brief(this.d.investigations.get(id)!);
        writeFileSync(join(out, "brief.json"), JSON.stringify(brief, null, 2));
        const r = await runFix({
          ...c, outDir: out,
          bundle: () => (this.d.bundle ?? ((f) => this.defaultBundle(f)))(join(out, "repo.bundle")),
          progress: (p) => { this.d.investigations.setFix(id, { progress: p }); },
        }, brief, ac.signal);
        if (!r.patch.trim() && (r.status.claude ?? 0) !== 0) {
          const never = r.claude && !r.claude.answered;
          if (never) this.d.budget.giveBack("fix");
          throw new Error(`Claude stopped before changing anything: ${r.claude?.error ?? `exit ${r.status.claude}`}${never ? " (the model never answered, so this run does not count toward today's 2)" : ""}`);
        }
        const review = reviewPatch(r.patch);
        this.d.activity.write("lass", "fix.review", id, { files: review.files.length, security: review.files.filter((f) => f.security).length, refused: review.refused.length, status: r.status });
        if (this.d.investigations.get(id)?.state !== "fixing") return;
        this.d.investigations.setFix(id, {
          stage: "review", progress: undefined, base: r.base, summary: r.summary.trim() || "(the fix run wrote no summary)",
          files: review.files, refused: review.refused, added: review.added, removed: review.removed, checks: r.status,
          ...(r.status.error ? { error: `the fix container stopped early (${r.status.error})` } : {}),
        }, "fix ready for review");
      } catch (e) {
        if (e instanceof FixRunCancelled || ac.signal.aborted) return;
        this.d.activity.write("lass", "fix.failed", id, { error: (e as Error).message });
        this.d.investigations.fixFailed(id, (e as Error).message);
      } finally {
        this.aborts.delete(id);
        this.d.changed();
      }
    })();
    return null;
  }

  /** Test on this PC (the user's click after seeing the patch; red files need their confirmation). */
  test(id: string, confirmedRed: boolean): string | null {
    const inv = this.d.investigations.get(id);
    const f = inv?.fix;
    if (!inv || inv.state !== "fixing" || f?.stage !== "review" || !f.base) return "this fix is not waiting for review";
    if (f.refused?.length) return `the patch is refused: ${f.refused[0]}`;
    if (!f.files?.length) return "the fix changed nothing";
    if (f.files.some((x) => x.security) && !confirmedRed) return "confirm that you read the red changes first";
    if (!this.d.repo) return this.unavailable() ?? "no project folder";
    const ac = new AbortController();
    this.aborts.set(id, ac);
    this.d.investigations.setFix(id, { stage: "testing", progress: "starting", error: undefined }, "test on this PC started by the user");
    this.d.activity.write("lass", "fix.test", id, { confirmedRed });
    const deps: FixTestDeps = {
      repo: this.d.repo, root: this.d.root, invId: id, base: f.base, patchFile: join(this.dir(id), "fix.patch"),
      summaryLine: (f.summary ?? "").split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "fix", logFile: this.log(id),
      progress: (step, n, of) => { this.d.investigations.setFix(id, { progress: `${step} (step ${n} of ${of})` }); },
    };
    void (async () => {
      try {
        appendFileSync(deps.logFile, `\n=== test of ${id} started ${new Date().toISOString()}\n`);
        const r = await (this.d.test ?? testFix)(deps, ac.signal);
        if (this.d.investigations.get(id)?.state !== "fixing") return;
        this.d.activity.write("lass", "fix.tested", id, { build: r.build });
        this.d.investigations.setFix(id, { stage: "ready", progress: undefined, build: r.build, branch: r.branch }, `tested on this PC: build ${r.build}`);
      } catch (e) {
        this.d.activity.write("lass", "fix.test.failed", id, { error: (e as Error).message });
        await (this.d.cleanUp ?? cleanUpFix)(this.d.repo!, this.d.root, id, false, deps.logFile).catch(() => undefined);
        if (this.d.investigations.get(id)?.state === "fixing") this.d.investigations.setFix(id, { stage: "review", progress: undefined, error: ac.signal.aborted ? "the test was cancelled" : (e as Error).message.slice(0, 600) }, "test on this PC failed");
      } finally {
        this.aborts.delete(id);
        this.d.changed();
      }
    })();
    return null;
  }

  /** Install and restart (the user's click). The launcher keeps the build only if it comes up tested. */
  install(id: string): string | null {
    const inv = this.d.investigations.get(id);
    const build = inv?.fix?.build;
    if (!inv || inv.state !== "fixing" || inv.fix?.stage !== "ready" || !build) return "this fix is not ready to install";
    try { this.d.setPending(build); } catch (e) { return (e as Error).message; }
    this.d.investigations.installing(id);
    this.d.activity.write("lass", "fix.install", id, { build });
    this.d.restart();
    return null;
  }

  /** Reject (the user's click): closes the investigation; the worktree and branch go, the patch stays in its folder. */
  reject(id: string): string | null {
    const inv = this.d.investigations.get(id);
    if (!inv || (inv.state !== "fixing" && inv.state !== "identified")) return "nothing to reject";
    this.aborts.get(id)?.abort();
    this.d.activity.write("lass", "fix.reject", id);
    this.d.investigations.closeWith(id, "failed: fix rejected by the user");
    if (this.d.repo) void (this.d.cleanUp ?? cleanUpFix)(this.d.repo, this.d.root, id, false, this.log(id)).catch(() => undefined);
    return null;
  }

  /** The user's answer on the fixed build. */
  verify(id: string, fixed: boolean): string | null {
    const inv = this.d.investigations.get(id);
    if (!inv || inv.state !== "verifying") return "nothing to confirm";
    this.d.activity.write("lass", "fix.verify", id, { fixed });
    if (fixed) this.closeFixed(inv);
    else this.d.investigations.closeWith(id, "failed: the fix did not solve the problem", "LASS's fix did not solve the problem. The fix stays installed; Help > Something's wrong reports what is still wrong.", this.mergeSteps(inv));
    return null;
  }

  private mergeSteps(inv: Investigation): string[] {
    const b = inv.fix?.branch ?? `lass/${inv.id}`;
    return [`Keep the fix in your project: in the project folder run "git merge ${b}" (then push). Until then, the next npm run package builds without it.`];
  }

  private closeFixed(inv: Investigation): void {
    this.d.investigations.closeWith(inv.id, "fixed", `LASS fixed it: ${(inv.fix?.summary ?? "").split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "see the fix summary"}`, this.mergeSteps(inv));
    if (this.d.repo) void (this.d.cleanUp ?? cleanUpFix)(this.d.repo, this.d.root, inv.id, true, this.log(inv.id)).catch(() => undefined);
  }

  /** At start-up: a fix that was being installed either runs now (verifying) or was rolled back by the launcher. */
  afterStart(): void {
    for (const inv of this.d.investigations.list().filter((i) => i.state === "verifying")) {
      const build = inv.fix?.build;
      if (build && this.d.currentBuild() !== build) {
        let reason = "the launcher did not keep the fixed build";
        try {
          const lines = readFileSync(join(this.d.lassDir, "rollouts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to?: string; ok?: boolean; reason?: string });
          const r = [...lines].reverse().find((x) => x.to === build && x.ok === false);
          if (r?.reason) reason = r.reason;
        } catch { /* no record */ }
        this.d.investigations.closeWith(inv.id, `failed: rollout: ${reason.slice(0, 160)}`, `The fixed build did not start properly, so the Dashboard went back to the previous build (${reason}).`);
      }
    }
  }

  /** A new-card request finished: on a fixed build, success for a repeat-failure investigation answers it. */
  afterRequest(outcome: string): void {
    if (outcome !== "installed") return;
    const inv = this.d.investigations.list().find((i) => i.state === "verifying" && i.signal.kind === "repeat-failure" && i.signal.function === "newcard.create");
    if (inv) this.closeFixed(inv);
  }
}
