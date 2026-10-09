// A stand-in for claude.exe in the generator tests (never used outside tests).
// --version prints a version. Otherwise it reads the prompt from stdin, logs the call to calls.jsonl
// next to itself, plays the next step of scenario.json (next to itself) and prints stream-json events
// like the real CLI: system/init (session id, tool list), assistant text, result.
// In file contents, {{CARD_ID}} becomes the card id from the host's request header (or manifest.json).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

class FakeClaude {
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    if (args.Length > 0 && args[0] == "--version") { Console.WriteLine("2.1.293 (Claude Code)"); return 0; }
    string stdin = Console.In.ReadToEnd();
    var js = new JavaScriptSerializer();
    js.MaxJsonLength = int.MaxValue;
    var log = new Dictionary<string, object> {
      { "args", args }, { "cwd", Environment.CurrentDirectory }, { "stdin", stdin },
      { "CLAUDE_CONFIG_DIR", Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") },
      { "USERPROFILE", Environment.GetEnvironmentVariable("USERPROFILE") },
      { "DISABLE_UPDATES", Environment.GetEnvironmentVariable("DISABLE_UPDATES") },
      { "ENABLE_CLAUDEAI_MCP_SERVERS", Environment.GetEnvironmentVariable("ENABLE_CLAUDEAI_MCP_SERVERS") },
    };
    File.AppendAllText(Path.Combine(dir, "calls.jsonl"), js.Serialize(log) + "\n");

    var scenario = js.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dir, "scenario.json")));
    var steps = (ArrayList)scenario["steps"];
    string countFile = Path.Combine(dir, "count.txt");
    int n = File.Exists(countFile) ? int.Parse(File.ReadAllText(countFile)) : 0;
    File.WriteAllText(countFile, (n + 1).ToString());
    var step = (Dictionary<string, object>)steps[Math.Min(n, steps.Count - 1)];

    string cardId = "";
    var m = Regex.Match(stdin, @"Card ID: ([a-z0-9-]+)");
    if (m.Success) cardId = m.Groups[1].Value;
    else if (File.Exists("manifest.json")) { var mm = Regex.Match(File.ReadAllText("manifest.json"), "\"id\"\\s*:\\s*\"([^\"]+)\""); if (mm.Success) cardId = mm.Groups[1].Value; }

    string session = step.ContainsKey("sessionId") ? (string)step["sessionId"] : "sess-" + n;
    object tools = step.ContainsKey("tools") ? step["tools"] : new string[] { "Read", "Edit", "Write" };
    Console.WriteLine(js.Serialize(new Dictionary<string, object> { { "type", "system" }, { "subtype", "init" }, { "session_id", session }, { "tools", tools } }));
    Console.Out.Flush();
    if (step.ContainsKey("sleepMs")) Thread.Sleep((int)step["sleepMs"]);
    if (step.ContainsKey("files")) {
      foreach (var kv in (Dictionary<string, object>)step["files"]) {
        string p = Path.GetFullPath(Path.Combine(Environment.CurrentDirectory, kv.Key));
        Directory.CreateDirectory(Path.GetDirectoryName(p));
        File.WriteAllText(p, ((string)kv.Value).Replace("{{CARD_ID}}", cardId));
      }
    }
    var text = new Dictionary<string, object> { { "type", "text" }, { "text", "Writing the card." } };
    Console.WriteLine(js.Serialize(new Dictionary<string, object> { { "type", "assistant" }, { "message", new Dictionary<string, object> { { "content", new object[] { text } } } } }));
    string subtype = step.ContainsKey("subtype") ? (string)step["subtype"] : "success";
    Console.WriteLine(js.Serialize(new Dictionary<string, object> { { "type", "result" }, { "subtype", subtype }, { "session_id", session }, { "result", "Done." } }));
    return step.ContainsKey("exit") ? (int)step["exit"] : 0;
  }
}
