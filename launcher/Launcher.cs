// Dashboard launcher (docs/LASS.md 8, "Updater"): Build\Dashboard.exe.
// Builds live side by side in Build\app\<build-id>\. Build\data\current-build.json names the current
// build, the previous one, and possibly a pending one (an update to try).
//   No pending build: start the current one and exit.
//   Pending build: wait for the old Dashboard to exit (--wait-pid), show a restart screen at its window
//   (--bounds x,y,w,h), start the pending build and wait for its ready report (Build\data\launcher\ready.json,
//   written by the build itself with its pid and whether its security-test record matches). Ready with a
//   matching record within --timeout seconds: it becomes current. Otherwise it is stopped, the current
//   build starts again, and the failed rollout is recorded in Build\data\lass\rollouts.jsonl.
//   Afterwards, builds other than current, previous and pending are removed beyond the newest three.
// Compiled with the C# compiler that ships with Windows (.NET Framework 4): scripts/build-launcher.mjs.
// Exit codes: 0 started (or rolled out), 2 nothing could be started, 3 rolled back to the previous build.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Launcher
{
    static string Root, Data, AppRoot, StateFile, ReadyFile, RolloutLog;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Regex BuildId = new Regex("^[0-9a-f]{12}$");
    static Form splash;

    [STAThread]
    static int Main(string[] args)
    {
        Root = Path.GetDirectoryName(Path.GetFullPath(Application.ExecutablePath));
        Data = Path.Combine(Root, "data");
        AppRoot = Path.Combine(Root, "app");
        StateFile = Path.Combine(Data, "current-build.json");
        ReadyFile = Path.Combine(Data, "launcher", "ready.json");
        RolloutLog = Path.Combine(Data, "lass", "rollouts.jsonl");

        int waitPid = IntArg(args, "--wait-pid", 0);
        int timeout = Math.Max(1, Math.Min(600, IntArg(args, "--timeout", 60)));
        bool noSplash = args.Contains("--no-splash");
        Rectangle? bounds = RectArg(args, "--bounds");

        var st = ReadState();
        string current = Get(st, "current"), previous = Get(st, "previous"), pending = Get(st, "pending");

        if (pending == null)
        {
            WaitExit(waitPid, 60);
            string exe = ExeOf(current) ?? LegacyExe();
            return exe != null && Start(exe) != null ? 0 : 2;
        }

        if (!noSplash) ShowSplash(bounds);
        try
        {
            WaitExit(waitPid, 60);
            string reason;
            var p = TryBuild(pending, timeout, out reason);
            if (p != null)
            {
                Save(new Dictionary<string, object> { { "current", pending }, { "previous", current != pending ? current : previous } });
                Record(current, pending, true, "ready, security-test record matches");
                Cleanup(pending, current);
                return 0;
            }
            Record(current, pending, false, reason);
            Save(new Dictionary<string, object> { { "current", current }, { "previous", previous } });
            string back = ExeOf(current) ?? LegacyExe();
            if (back != null) Start(back);
            return 3;
        }
        finally { if (splash != null) splash.Close(); }
    }

    // Starts the pending build and waits for its own ready report. Returns the process, or null with the reason.
    static Process TryBuild(string id, int timeoutSec, out string reason)
    {
        string exe = ExeOf(id);
        if (exe == null) { reason = "the build " + id + " is not installed"; return null; }
        try { if (File.Exists(ReadyFile)) File.Delete(ReadyFile); } catch { }
        var p = Start(exe);
        if (p == null) { reason = "the build could not be started"; return null; }
        var until = DateTime.UtcNow.AddSeconds(timeoutSec);
        while (DateTime.UtcNow < until)
        {
            Pump(200);
            if (p.HasExited) { reason = "the build exited (code " + p.ExitCode + ") before it was ready"; return null; }
            var r = ReadReady();
            if (r != null && Convert.ToInt32(r["pid"]) == p.Id)
            {
                if (r.ContainsKey("hostSuiteOk") && r["hostSuiteOk"] is bool && (bool)r["hostSuiteOk"]) { reason = ""; return p; }
                Kill(p);
                reason = "its security-test record does not match this build";
                return null;
            }
        }
        Kill(p);
        reason = "it did not report ready within " + timeoutSec + " s";
        return null;
    }

    static Dictionary<string, object> ReadReady()
    {
        try { return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ReadyFile)); } catch { return null; }
    }

    static Dictionary<string, object> ReadState()
    {
        try { return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(StateFile)) ?? new Dictionary<string, object>(); }
        catch { return new Dictionary<string, object>(); }
    }

    // Only well-formed build ids count; anything else in the state file is ignored.
    static string Get(Dictionary<string, object> st, string key)
    {
        object v;
        return st.TryGetValue(key, out v) && v is string && BuildId.IsMatch((string)v) ? (string)v : null;
    }

    static void Save(Dictionary<string, object> st)
    {
        foreach (var k in st.Keys.ToList()) if (st[k] == null) st.Remove(k);
        Directory.CreateDirectory(Data);
        string tmp = StateFile + ".tmp";
        File.WriteAllText(tmp, Json.Serialize(st));
        if (File.Exists(StateFile)) File.Replace(tmp, StateFile, null); else File.Move(tmp, StateFile);
    }

    static void Record(string from, string to, bool ok, string reason)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(RolloutLog));
            var e = new Dictionary<string, object> { { "at", DateTime.UtcNow.ToString("o") }, { "from", from }, { "to", to }, { "ok", ok }, { "reason", reason } };
            File.AppendAllText(RolloutLog, Json.Serialize(e) + "\n");
        }
        catch { }
    }

    static string ExeOf(string id)
    {
        if (id == null) return null;
        string exe = Path.Combine(AppRoot, id, "Dashboard.exe");
        return File.Exists(exe) ? exe : null;
    }

    // Before the first side-by-side build: the app folder itself.
    static string LegacyExe()
    {
        string exe = Path.Combine(AppRoot, "Dashboard.exe");
        return File.Exists(exe) ? exe : null;
    }

    static Process Start(string exe)
    {
        try { return Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) }); }
        catch { return null; }
    }

    static void Kill(Process p)
    {
        try { if (!p.HasExited) Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + p.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(10000); } catch { }
        try { if (!p.HasExited) p.Kill(); } catch { }
    }

    static void WaitExit(int pid, int seconds)
    {
        if (pid <= 0) return;
        Process p;
        try { p = Process.GetProcessById(pid); } catch { return; }
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < until) { try { if (p.HasExited) return; } catch { return; } Pump(200); }
    }

    // Keeps current, previous and the newest builds up to three; a folder that is still in use stays for next time.
    static void Cleanup(params string[] keep)
    {
        try
        {
            var dirs = new DirectoryInfo(AppRoot).GetDirectories().Where(d => BuildId.IsMatch(d.Name)).OrderByDescending(d => d.CreationTimeUtc).ToList();
            var kept = new HashSet<string>(keep.Where(k => k != null));
            foreach (var d in dirs) if (kept.Count < 3) kept.Add(d.Name);
            foreach (var d in dirs) if (!kept.Contains(d.Name)) { try { d.Delete(true); } catch { } }
        }
        catch { }
    }

    static void ShowSplash(Rectangle? bounds)
    {
        splash = new Form
        {
            FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual, TopMost = true, ShowInTaskbar = true,
            Text = "Dashboard", BackColor = Color.FromArgb(27, 31, 39), ForeColor = Color.FromArgb(230, 233, 239),
        };
        var area = Screen.PrimaryScreen.WorkingArea;
        var r = bounds ?? new Rectangle(area.Left + (area.Width - 480) / 2, area.Top + (area.Height - 200) / 2, 480, 200);
        if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) r = new Rectangle(area.Left + 40, area.Top + 40, Math.Min(r.Width, area.Width - 80), Math.Min(r.Height, area.Height - 80));
        splash.Bounds = r;
        splash.Controls.Add(new Label { Text = "Updating the Dashboard…\r\nIt starts again in a moment.", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 14f) });
        splash.Show();
        Pump(50);
    }

    static void Pump(int ms) { Application.DoEvents(); Thread.Sleep(ms); }

    static int IntArg(string[] a, string name, int def)
    {
        int i = Array.IndexOf(a, name), v;
        return i >= 0 && i + 1 < a.Length && int.TryParse(a[i + 1], out v) ? v : def;
    }

    static Rectangle? RectArg(string[] a, string name)
    {
        int i = Array.IndexOf(a, name);
        if (i < 0 || i + 1 >= a.Length) return null;
        var p = a[i + 1].Split(',');
        int x, y, w, h;
        if (p.Length == 4 && int.TryParse(p[0], out x) && int.TryParse(p[1], out y) && int.TryParse(p[2], out w) && int.TryParse(p[3], out h) && w >= 200 && h >= 120 && w <= 10000 && h <= 10000)
            return new Rectangle(x, y, w, h);
        return null;
    }
}
