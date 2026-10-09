/**
 * Markdown -> a small tree of safe nodes (for api.ui.markdown). Report bodies are untrusted, so:
 *   - no HTML ever: raw tags stay literal text (the DOM is built with textContent only);
 *   - no remote loads: images become their alt text;
 *   - links only for https URLs (the only kind api.ui.openLink opens), opened by the host on click;
 *     anything else stays text. A URL that appears inside literal HTML text is just a visible link.
 * Supported: headings, paragraphs, emphasis, strong, strikethrough, inline code, code blocks,
 * block quotes, lists (nested by indentation), rules, pipe tables, links and bare URLs.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "pre"; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

const MAX_DEPTH = 8;

export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

// ---------- inline ----------

interface Pat { re: RegExp; make: (m: RegExpExecArray, depth: number) => Inline }
const INLINE: Pat[] = [
  { re: /`([^`\n]+)`/, make: (m) => ({ t: "code", v: m[1] }) },
  { re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/, make: (m) => ({ t: "text", v: m[1] ? `[image: ${m[1]}]` : "[image]" }) },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/, make: (m, d) => { const h = safeHref(m[2]); return h ? { t: "link", href: h, c: inline(m[1], d + 1) } : { t: "text", v: m[0] }; } },
  { re: /<(https?:\/\/[^>\s]+)>/, make: (m) => { const h = safeHref(m[1]); return h ? { t: "link", href: h, c: [{ t: "text", v: m[1] }] } : { t: "text", v: m[0] }; } },
  { re: /\*\*(?=\S)([^\n]+?)\*\*|__(?=\S)([^\n]+?)__/, make: (m, d) => ({ t: "strong", c: inline(m[1] ?? m[2], d + 1) }) },
  { re: /~~(?=\S)([^\n]+?)~~/, make: (m, d) => ({ t: "del", c: inline(m[1], d + 1) }) },
  { re: /\*(?=[^\s*])([^\n*]+?)\*|(?<![A-Za-z0-9_])_(?=[^\s_])([^\n_]+?)_(?![A-Za-z0-9_])/, make: (m, d) => ({ t: "em", c: inline(m[1] ?? m[2], d + 1) }) },
  { re: /https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/, make: (m) => { const h = safeHref(m[0]); return h ? { t: "link", href: h, c: [{ t: "text", v: m[0] }] } : { t: "text", v: m[0] }; } },
];

export function inline(src: string, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return [{ t: "text", v: src }];
  const out: Inline[] = [];
  let rest = src;
  while (rest.length) {
    let best: { i: number; m: RegExpExecArray; p: Pat } | null = null;
    for (const p of INLINE) {
      const m = p.re.exec(rest);
      if (m && (!best || m.index < best.i)) best = { i: m.index, m, p };
    }
    if (!best) { pushText(out, rest); break; }
    if (best.i > 0) pushText(out, rest.slice(0, best.i));
    out.push(best.p.make(best.m, depth));
    rest = rest.slice(best.i + best.m[0].length);
  }
  return out;
}

function pushText(out: Inline[], v: string): void {
  const parts = v.split(/ {2,}\n|\\\n/);   // hard line breaks
  parts.forEach((p, i) => {
    if (i > 0) out.push({ t: "br" });
    const s = p.replace(/\n/g, " ");
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.t === "text") last.v += s; else out.push({ t: "text", v: s });
  });
}

// ---------- blocks ----------

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR_RE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

export function parse(src: string, depth = 0): Block[] {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { blocks.push({ t: "h", level: h[1].length, c: inline(h[2]) }); i++; continue; }
    if (HR_RE.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(depth < MAX_DEPTH ? { t: "quote", c: parse(body.join("\n"), depth + 1) } : { t: "p", c: inline(body.join("\n")) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = cells(line).map((c) => inline(c));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]).map((c) => inline(c)));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const indent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) {
          if (m && m[1].length > indent && items.length) {
            // nested list: collect the deeper lines and parse them as one block
            const sub: string[] = [];
            while (i < lines.length && lines[i].trim() && (LIST_RE.exec(lines[i])?.[1].length ?? 0) > indent) sub.push(lines[i++].slice(indent + 2));
            if (depth < MAX_DEPTH) items[items.length - 1].push(...parse(sub.join("\n"), depth + 1));
            continue;
          }
          if (m || !lines[i].trim()) break;
          if (/^\s+\S/.test(lines[i]) && items.length) { items[items.length - 1].push({ t: "p", c: inline(lines[i++].trim()) }); continue; }
          break;
        }
        items.push([{ t: "p", c: inline(m[3]) }]);
        i++;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !HR_RE.test(lines[i]) && !LIST_RE.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push({ t: "p", c: inline(para.join("\n")) });
  }
  return blocks;
}
