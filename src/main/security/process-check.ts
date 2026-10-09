/**
 * OS rights below the broker (ARCHITECTURE.md, "One isolated runtime per card").
 * Reads a card renderer's Windows token and job membership. The host starts card code only if
 * the process runs at Untrusted integrity with a restricted token inside a job object, so Windows
 * itself refuses the process anything the broker does not do for it.
 * Fail closed: if the check cannot be made, the card does not run.
 */
import koffi from "koffi";

export interface ProcessRights {
  pid: number;
  integrityRid: number;
  integrity: string;
  restrictedToken: boolean;
  inJob: boolean;
  appContainer: boolean;
}

export type RightsResult = { ok: true; rights: ProcessRights } | { ok: false; reason: string; rights?: ProcessRights };

/** Highest integrity RID a card process may have. 0x0000 = Untrusted (SECURITY_MANDATORY_UNTRUSTED_RID). */
export const MAX_CARD_INTEGRITY_RID = 0x0000;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TokenIntegrityLevel = 25;
const TokenIsAppContainer = 29;

interface Win32 {
  OpenProcess: (access: number, inherit: number, pid: number) => unknown;
  CloseHandle: (h: unknown) => number;
  GetLastError: () => number;
  OpenProcessToken: (h: unknown, access: number, out: unknown[]) => number;
  GetTokenInformation: (tok: unknown, cls: number, buf: Buffer | null, len: number, retLen: number[]) => number;
  GetSidSubAuthorityCount: (sid: unknown) => unknown;
  GetSidSubAuthority: (sid: unknown, i: number) => unknown;
  IsTokenRestricted: (tok: unknown) => number;
  IsProcessInJob: (h: unknown, job: unknown, out: number[]) => number;
}

let win32: Win32 | null = null;
function api(): Win32 {
  if (win32) return win32;
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
  win32 = {
    OpenProcess: kernel32.func("HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)"),
    CloseHandle: kernel32.func("int __stdcall CloseHandle(HANDLE hObject)"),
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
    IsProcessInJob: kernel32.func("int __stdcall IsProcessInJob(HANDLE ProcessHandle, HANDLE JobHandle, _Out_ int *Result)"),
    OpenProcessToken: advapi32.func("int __stdcall OpenProcessToken(HANDLE ProcessHandle, uint32_t DesiredAccess, _Out_ HANDLE *TokenHandle)"),
    GetTokenInformation: advapi32.func("int __stdcall GetTokenInformation(HANDLE TokenHandle, int TokenInformationClass, _Out_ void *TokenInformation, uint32_t TokenInformationLength, _Out_ uint32_t *ReturnLength)"),
    GetSidSubAuthorityCount: advapi32.func("uint8_t * __stdcall GetSidSubAuthorityCount(void *pSid)"),
    GetSidSubAuthority: advapi32.func("uint32_t * __stdcall GetSidSubAuthority(void *pSid, uint32_t nSubAuthority)"),
    IsTokenRestricted: advapi32.func("int __stdcall IsTokenRestricted(HANDLE TokenHandle)"),
  } as unknown as Win32;
  void HANDLE;
  return win32;
}

function integrityName(rid: number): string {
  if (rid < 0x1000) return "untrusted";
  if (rid < 0x2000) return "low";
  if (rid < 0x3000) return "medium";
  if (rid < 0x4000) return "high";
  return "system";
}

/** Reads the rights of a process. Throws with a plain-words reason if Windows refuses the query. */
export function readProcessRights(pid: number): ProcessRights {
  if (process.platform !== "win32") throw new Error("process rights can only be checked on Windows");
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid process id ${pid}`);
  const w = api();
  const hProc = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!hProc) throw new Error(`cannot open process ${pid} (error ${w.GetLastError()})`);
  try {
    const tokOut: unknown[] = [null];
    if (!w.OpenProcessToken(hProc, TOKEN_QUERY, tokOut)) throw new Error(`cannot open the token of process ${pid} (error ${w.GetLastError()})`);
    const hTok = tokOut[0];
    try {
      const len = [0];
      const buf = Buffer.alloc(256);
      if (!w.GetTokenInformation(hTok, TokenIntegrityLevel, buf, buf.length, len)) throw new Error(`cannot read the integrity level of process ${pid} (error ${w.GetLastError()})`);
      // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label { PSID Sid; DWORD Attributes } }; the SID lives in the same buffer.
      const sid = koffi.decode(buf, "void *");
      const count = koffi.decode(w.GetSidSubAuthorityCount(sid), "uint8_t") as number;
      const rid = koffi.decode(w.GetSidSubAuthority(sid, count - 1), "uint32_t") as number;

      const ac = Buffer.alloc(4);
      const acOk = w.GetTokenInformation(hTok, TokenIsAppContainer, ac, 4, [0]);
      const inJob = [0];
      if (!w.IsProcessInJob(hProc, null, inJob)) throw new Error(`cannot read the job membership of process ${pid} (error ${w.GetLastError()})`);
      return {
        pid,
        integrityRid: rid,
        integrity: integrityName(rid),
        restrictedToken: w.IsTokenRestricted(hTok) !== 0,
        inJob: inJob[0] !== 0,
        appContainer: acOk ? ac.readUInt32LE(0) !== 0 : false,
      };
    } finally {
      w.CloseHandle(hTok);
    }
  } finally {
    w.CloseHandle(hProc);
  }
}

/** The policy: every condition must hold for card code to run. */
export function checkCardProcess(pid: number): RightsResult {
  let rights: ProcessRights;
  try { rights = readProcessRights(pid); }
  catch (e) { return { ok: false, reason: (e as Error).message }; }
  const problems: string[] = [];
  if (rights.integrityRid > MAX_CARD_INTEGRITY_RID) problems.push(`integrity level is ${rights.integrity} (0x${rights.integrityRid.toString(16)}), not untrusted`);
  if (!rights.restrictedToken && !rights.appContainer) problems.push("token is neither restricted nor an AppContainer token");
  if (!rights.inJob) problems.push("process is not in a job object");
  return problems.length ? { ok: false, reason: problems.join("; "), rights } : { ok: true, rights };
}
