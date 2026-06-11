import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * draft token — authenticates the draft-preview iframe surfaces.
 *
 * The preview iframe is sandboxed WITHOUT allow-same-origin (opaque origin),
 * so no cookies cross into /draft/* or /api/draft/* requests. This HMAC token,
 * minted by the workspace RSC AFTER its RLS project read proved membership,
 * is the only authz those routes have. Scope: read-only rendering of one
 * project's draft. Format: `<expMs>.<hex hmac-sha256(projectId.expMs)>`.
 */
export const DRAFT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h — outlives an editing session

function secret(): string {
  const s = process.env.JAB_DRAFT_TOKEN_SECRET || process.env.JAB_ENCRYPTION_KEY;
  if (!s) {
    throw new Error(
      "draft-token: set JAB_DRAFT_TOKEN_SECRET (or JAB_ENCRYPTION_KEY) to sign draft preview tokens",
    );
  }
  return s;
}

function sign(projectId: string, exp: number): string {
  return createHmac("sha256", secret()).update(`${projectId}.${exp}`).digest("hex");
}

export function mintDraftToken(projectId: string, nowMs = Date.now()): string {
  const exp = nowMs + DRAFT_TOKEN_TTL_MS;
  return `${exp}.${sign(projectId, exp)}`;
}

export function verifyDraftToken(
  projectId: string,
  token: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  let got: Buffer;
  try {
    got = Buffer.from(token.slice(dot + 1), "hex");
  } catch {
    return false;
  }
  const want = Buffer.from(sign(projectId, exp), "hex");
  return got.length === want.length && got.length > 0 && timingSafeEqual(got, want);
}
