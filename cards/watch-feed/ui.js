// Watch feed (preset "watch-feed", PRESETS.md; reference card 2 in CARDS.md).
// Shows the latest valid report of one scheduled task, with a "Feed offline" banner when the feed fails.
// The severity is shown by the host frame, the way the user's theme chooses (api.ui.setAccent); the card
// writes it only as a word. Colours and sizes come from the theme (CSS variables, em). All report content
// is untrusted: text and api.ui.markdown only.

const LABELS = { none: "None", low: "Low", medium: "Medium", high: "High", critical: "Critical" };
const OFFLINE = { "invalid-file": "the newest report file is invalid", "run-failed": "the last run failed", overdue: "no report arrived when one was expected" };

let stopWatching = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function render(root, api, state) {
  root.replaceChildren();
  const r = state.latest;
  const sev = r ? r.severity : "none";
  root.dataset.severity = sev;
  api.ui.setAccent(sev);

  if (state.offline) {
    const b = el("div", "feed-offline");
    b.setAttribute("role", "alert");
    b.append(el("strong", "", "Feed offline: "), document.createTextNode(`${OFFLINE[state.offline.reason] ?? state.offline.reason}. ${state.offline.detail}`));
    if (r) b.append(el("div", "feed-muted", `Showing the last good report, from ${when(r.runFinishedAt)}.`));
    root.append(b);
  }
  if (!r) {
    root.append(el("p", "feed-muted", "No report has arrived yet. The first one appears here after the task's next run."));
    api.ui.setStatus(state.offline ? { state: "stale", message: "feed offline, no report yet" } : { state: "ok", message: "waiting for the first report" });
    return;
  }
  const head = el("div", "feed-head");
  head.append(el("span", `feed-sev sev-${sev}`, `Severity: ${LABELS[sev] ?? sev}`), el("span", "feed-muted", when(r.runFinishedAt)));
  root.append(head, el("p", "feed-bottom", r.bottomLine));
  const body = el("div", "feed-body");
  body.append(api.ui.markdown(r.body));
  root.append(body);
  if (r.sources.length) {
    const h = el("h4", "", "Sources");
    const ul = el("ul", "feed-sources");
    for (const s of r.sources) {
      const li = el("li");
      const a = el("a", "md-link", s.title || s.url);
      a.title = s.url;
      a.tabIndex = 0;
      a.setAttribute("role", "link");
      const go = (e) => { e.preventDefault(); api.ui.openLink(s.url).catch((err) => api.ui.notify(`Could not open the link: ${err.message}`, "warning")); };
      a.addEventListener("click", go);
      a.addEventListener("keydown", (e) => { if (e.key === "Enter") go(e); });
      li.append(a);
      ul.append(li);
    }
    root.append(h, ul);
  }
  api.ui.setStatus(state.offline
    ? { state: "stale", message: `feed offline: ${OFFLINE[state.offline.reason] ?? state.offline.reason}`, updatedAt: r.runFinishedAt }
    : { state: "ok", updatedAt: r.runFinishedAt });
}

const CSS = `
.feed-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.feed-sev { font-weight: 700; text-transform: uppercase; letter-spacing: .04em; font-size: .923em; padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; }
.feed-bottom { font-size: 1.154em; font-weight: 600; margin: 8px 0; }
.feed-muted { color: var(--muted); font-size: .923em; }
.feed-offline { border: 2px solid var(--warn); padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; }
.feed-offline strong { color: var(--warn); }
.feed-sources { padding-left: 18px; }
`;

export async function mount(root, api) {
  if (!document.getElementById("feed-style")) {
    const st = document.createElement("style");
    st.id = "feed-style";
    st.textContent = CSS;
    document.head.append(st);
  }
  api.ui.setStatus({ state: "loading" });
  const taskId = String(api.card.config.taskId ?? "");
  try {
    render(root, api, await api.reports.state(taskId));
    stopWatching = api.reports.onChange(taskId, (s) => render(root, api, s));
  } catch (e) {
    root.replaceChildren(el("p", "feed-muted", `This feed cannot be read: ${e.message}`));
    api.ui.setStatus({ state: "error", message: e.message });
  }
}

export function unmount() {
  if (stopWatching) stopWatching();
  stopWatching = null;
}
