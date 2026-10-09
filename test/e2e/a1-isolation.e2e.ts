/** TESTPLAN A1: card isolation (own OS process, sandboxed, no Node, OS rights). */
import { expect, test } from "@playwright/test";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, snapshot, waitFor } from "./helpers";

const probe = `${PRELUDE}
export async function mount(el, api) {
  el.textContent = "probe";
  await report(api, "globals", {
    require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer,
    electron: typeof window.electron, ipcRenderer: typeof window.ipcRenderer, dashboardHost: typeof window.dashboardHost,
    origin: location.origin,
  });
  api.ui.setStatus({ state: "ok", message: "probed" });
}
export function unmount() {}
`;

test("each card runs alone in a sandboxed, Node-free, Untrusted-integrity process", async () => {
  const inst = makeInstance();
  addCard(inst, { id: "probe-one", ui: probe });
  addCard(inst, { id: "probe-two", ui: probe });
  const app = await launch(inst);
  try {
    await waitFor(() => cardStorage(inst, "probe-one") && cardStorage(inst, "probe-two"), "both probes to report");
    const snap = await snapshot(app);
    expect(snap.stopped, JSON.stringify(snap.stopped)).toEqual([]);
    expect(snap.running).toHaveLength(2);

    const pids = snap.running.map((c) => c.pid);
    expect(pids.every((p) => typeof p === "number" && p > 0)).toBe(true);
    expect(new Set(pids).size).toBe(2);
    expect(pids).not.toContain(snap.mainPid);
    expect(pids).not.toContain(snap.dashboardPid);

    for (const c of snap.running) {
      const r = c.rights as { integrity: string; restrictedToken: boolean; appContainer: boolean; inJob: boolean };
      expect(r.integrity, `${c.cardId} integrity`).toBe("untrusted");
      expect(r.restrictedToken || r.appContainer, `${c.cardId} restricted`).toBe(true);
      expect(r.inJob, `${c.cardId} job`).toBe(true);

      const g = (cardStorage(inst, c.cardId)!.results as Record<string, unknown>).globals as Record<string, string>;
      expect(g).toMatchObject({ require: "undefined", process: "undefined", module: "undefined", Buffer: "undefined", electron: "undefined", ipcRenderer: "undefined", dashboardHost: "undefined" });
      expect(g.origin).toBe(`card://${c.cardId}`);
    }
    console.log("card process rights:", JSON.stringify(snap.running.map((c) => c.rights)));
  } finally {
    await app.close();
  }
});
