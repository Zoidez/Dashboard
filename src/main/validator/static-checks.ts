/**
 * VALIDATOR.md V4: static security checks on ui.js / worker.js, without running them.
 * They catch honest mistakes and obvious tricks; they are not the boundary (the runtime wrapper is,
 * and V5 exercises it). Also collects which api.* members the code uses, for V2 and the coverage check.
 */
import ts from "typescript";

export interface ApiUse { ns: string; member: string; line: number }
export interface StaticResult { errors: string[]; uses: ApiUse[] }

const NET_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "RTCPeerConnection", "importScripts", "SharedWorker", "Worker", "BroadcastChannel", "WebTransport"]);
const NODE_GLOBALS = new Set(["require", "process", "module", "Buffer", "__dirname", "__filename"]);
const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc", "createContextualFragment", "outerText"]);
const DANGEROUS_TAGS = new Set(["script", "iframe", "object", "embed", "frame", "frameset", "base", "link", "meta", "form", "portal"]);
const API_NS = new Set(["card", "fs", "net", "sysinfo", "reports", "storage", "ui", "messaging", "process", "ffi", "bus", "claude"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "document", "api"]);

export function staticChecks(file: string, source: string): StaticResult {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  const errors: string[] = [];
  const uses: ApiUse[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const err = (n: ts.Node, msg: string) => errors.push(`${file}:${at(n)}: ${msg}`);
  const name = (e: ts.Expression): string | null => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);
  const rootName = (e: ts.Expression): string | null => {
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
  };

  // Parse errors first: unparsable code is rejected outright.
  for (const d of (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []) {
    errors.push(`${file}: syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }

  const visit = (n: ts.Node): void => {
    // Identifiers that must not appear as values (globals); property names (obj.fetch) are fine.
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
      && !ts.isImportSpecifier(n.parent) && !ts.isBindingElement(n.parent) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)
      && !(ts.isParameter(n.parent)) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !ts.isMethodDeclaration(n.parent)) {
      if (n.text === "eval") err(n, "eval is not allowed");
      if (n.text === "Function" && (ts.isNewExpression(n.parent) || ts.isCallExpression(n.parent))) err(n, "the Function constructor is not allowed");
      if (NET_GLOBALS.has(n.text)) err(n, `${n.text} is direct network or a new execution context; use api.net.request (direct network is blocked)`);
      if (NODE_GLOBALS.has(n.text)) err(n, `${n.text} is Node.js; cards have no Node.js`);
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const cn = name(callee);
      if ((cn === "setTimeout" || cn === "setInterval") && n.arguments[0] && (ts.isStringLiteralLike(n.arguments[0]) || ts.isTemplateExpression(n.arguments[0]))) err(n, `${cn} with a string runs code from text; pass a function`);
      if (ts.isPropertyAccessExpression(callee)) {
        const obj = name(callee.expression);
        if ((callee.name.text === "write" || callee.name.text === "writeln") && obj === "document") err(n, "document.write is not allowed");
        if (callee.name.text === "sendBeacon") err(n, "navigator.sendBeacon is direct network; use api.net.request");
        if (callee.name.text === "open" && (obj === "window" || ts.isIdentifier(callee.expression) && callee.expression.text === "open")) err(n, "window.open is not allowed; links open through api.ui.openLink");
        if ((callee.name.text === "assign" || callee.name.text === "replace" || callee.name.text === "reload") && obj === "location") err(n, `location.${callee.name.text} navigates the card; not allowed`);
        if (callee.name.text === "register" && obj === "serviceWorker") err(n, "service workers are not allowed");
        if (callee.name.text === "createElement" || callee.name.text === "createElementNS") {
          const a = n.arguments[callee.name.text === "createElement" ? 0 : 1];
          // A computed tag cannot be judged here; the card CSP blocks inline and remote scripts at runtime.
          if (a && ts.isStringLiteralLike(a) && DANGEROUS_TAGS.has(a.text.toLowerCase())) err(n, `creating <${a.text}> elements is not allowed`);
        }
        if (callee.name.text === "setAttribute" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
          const attr = n.arguments[0].text.toLowerCase();
          if (attr.startsWith("on")) err(n, `setting the ${attr} attribute runs code from text; use addEventListener`);
          if (attr === "href" || attr === "src" || attr === "srcdoc" || attr === "target" || attr === "action" || attr === "formaction") err(n, `setting ${attr} can navigate or load from outside; links open through api.ui.openLink`);
        }
      }
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const a = n.arguments[0];
        if (!a || !ts.isStringLiteralLike(a) || !/^\.{0,2}\//.test(a.text) || /^[a-z]+:/i.test(a.text)) err(n, "dynamic import() is allowed only for the card's own files, by a literal relative path");
      }
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier) && !/^\.{0,2}\//.test(n.moduleSpecifier.text)) err(n, `import from "${n.moduleSpecifier.text}" is not allowed; only the card's own files`);
    if (ts.isPropertyAccessExpression(n)) {
      if (HTML_SINKS.has(n.name.text)) err(n, `${n.name.text} turns text into HTML; build elements and use textContent or api.ui.markdown`);
      if (n.name.text === "location" && ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) err(n, "assigning location navigates the card; not allowed");
      if ((n.name.text === "href" || n.name.text === "src" || n.name.text === "action" || n.name.text === "target") && ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        err(n, `setting .${n.name.text} can navigate or load from outside; links open through api.ui.openLink`);
      }
      // api.<ns>.<member>: record the use (whatever the api parameter is called).
      if (ts.isPropertyAccessExpression(n.expression) && API_NS.has(n.expression.name.text) && !ts.isPropertyAccessExpression(n.parent)) {
        const ns = n.expression.name.text;
        uses.push({ ns, member: n.name.text, line: at(n) });
        if (ns === "process" || ns === "claude" || ns === "bus") err(n, `api.${ns} is reserved and disabled in apiVersion 0`);
        if (ns === "ffi") err(n, "api.ffi does not exist: cards can never call native code");
      }
    }
    if (ts.isElementAccessExpression(n) && !ts.isStringLiteralLike(n.argumentExpression) && !ts.isNumericLiteral(n.argumentExpression)) {
      const root = rootName(n);
      const objIsApi = ts.isPropertyAccessExpression(n.expression) && API_NS.has(n.expression.name.text);
      if ((root && GLOBAL_OBJECTS.has(root) && n.expression.kind === ts.SyntaxKind.Identifier) || objIsApi) err(n, `computed property access on ${root ?? "api"} hides what the code uses; use plain property names`);
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      if (HTML_SINKS.has(n.argumentExpression.text)) err(n, `${n.argumentExpression.text} turns text into HTML`);
      if (ts.isPropertyAccessExpression(n.expression) && API_NS.has(n.expression.name.text)) uses.push({ ns: n.expression.name.text, member: n.argumentExpression.text, line: at(n) });
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) err(n, "JSX is not supported in cards");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { errors, uses };
}

/** SVG assets: no scripts, no event attributes, no external references (VALIDATOR.md V4). */
export function svgChecks(file: string, text: string): string[] {
  const errors: string[] = [];
  if (/<\s*script/i.test(text)) errors.push(`${file}: SVG contains a script`);
  if (/\son[a-z]+\s*=/i.test(text)) errors.push(`${file}: SVG contains an event attribute`);
  if (/<\s*foreignObject/i.test(text)) errors.push(`${file}: SVG contains foreignObject`);
  if (/(?:href|src)\s*=\s*["']\s*(?!#)(?!data:image\/)/i.test(text)) errors.push(`${file}: SVG references something outside itself`);
  if (/url\(\s*["']?\s*(?!#)/i.test(text)) errors.push(`${file}: SVG style references something outside itself`);
  return errors;
}
