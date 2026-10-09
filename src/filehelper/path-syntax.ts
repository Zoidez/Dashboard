/**
 * Check 1 of the file check protocol: path syntax. Pure (no native code), so the broker runs it on
 * the card's raw path before anything else touches the path, and the helper runs it again.
 * Nothing may normalize a card's path before this check: Node's path.resolve turns "\\?\C:\x" and
 * "\\host\share" into paths on the current drive and removes "..", which would hide them from it.
 */

export class PathSyntaxError extends Error {
  readonly code = "InvalidArgument" as const;
  readonly check = "syntax" as const;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;

/** Returns the normalized path ("C:\a\b") or throws PathSyntaxError. */
export function checkSyntax(raw: unknown): string {
  const fail = (why: string): never => { throw new PathSyntaxError(`invalid path: ${why}`); };
  if (typeof raw !== "string" || raw.length === 0) fail("not a string");
  const s = raw as string;
  if (s.length > 260) fail("longer than 260 characters");
  if (/^[\\/]{2}/.test(s)) fail("network, device and \\\\?\\ paths are not allowed");
  if (/^\.[\\/]/.test(s)) fail("instance-relative paths (./) point inside the Dashboard's own folder");
  const p = s.replace(/\//g, "\\");
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (!m) fail("must be a full path starting with a drive letter, such as C:\\");
  const parts = m![2].split("\\");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();   // one trailing backslash is fine
  for (const c of parts) {
    if (c === "") fail("empty folder name (double backslash)");
    if (c === "." || c === "..") fail("\".\" and \"..\" are not allowed");
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(c)) fail(`"${c}" contains a character Windows reserves (: < > " | ? * or a control character); ":" would name an alternate data stream`);
    if (/[. ]$/.test(c)) fail(`"${c}" ends with a dot or a space`);
    if (RESERVED.test(c.split(".")[0].trim())) fail(`"${c}" is a reserved device name`);
    if (c.length > 255) fail("a name is longer than 255 characters");
  }
  return `${m![1].toUpperCase()}:\\${parts.join("\\")}`;
}
