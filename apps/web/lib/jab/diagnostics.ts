import "server-only";
import { Buffer } from "node:buffer";
import type { JabCredentials } from "./ability-client";

export interface DiagnosticsCheck {
  id: string;
  label: string;
  severity: "pass" | "warn" | "fail";
  message: string;
  detail?: string | string[] | null;
}
export interface DiagnosticsFact {
  id: string;
  label: string;
  value: unknown;
  detail?: unknown;
}
export interface DiagnosticsReport {
  plugin_version: string;
  generated_at: string;
  summary: { pass: number; warn: number; fail: number };
  facts: DiagnosticsFact[];
  checks: DiagnosticsCheck[];
}

export function isDiagnosticsReport(v: unknown): v is DiagnosticsReport {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.summary === "object" &&
    o.summary !== null &&
    Array.isArray(o.checks) &&
    Array.isArray(o.facts)
  );
}

/**
 * Fail-soft GET /wp-json/jab/v1/diagnostics (plugin v0.7.1+, default cap
 * manage_options). Returns null on any non-200 (pre-v0.7.1 404, or 403 when
 * the app password lacks manage_options), network error, or guard failure.
 * Same redirect-manual SSRF posture as ability-client.ts wpRestFetch.
 */
export async function getDiagnostics(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<DiagnosticsReport | null> {
  const auth = Buffer.from(`${creds.username}:${creds.appPassword}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(`${creds.wpUrl.replace(/\/+$/, "")}/wp-json/jab/v1/diagnostics`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) return null;
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isDiagnosticsReport(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
