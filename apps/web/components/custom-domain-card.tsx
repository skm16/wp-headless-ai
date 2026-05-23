"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format-relative";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { StatusDot } from "@/components/ui/status-dot";

export type CustomDomainStatus = "none" | "pending-dns" | "verified" | "active";

export interface CustomDomainState {
  status: CustomDomainStatus;
  /** The domain the user entered. Required for any state except "none". */
  domain?: string;
  /** Most recent DNS / verification check. */
  lastCheckedAt?: Date;
  /** Verification-failure copy from the last check (e.g. CNAME mismatch). */
  error?: string;
}

export interface CustomDomainCardProps {
  state: CustomDomainState;
  /** The Jab-side host the customer's CNAME should point at. */
  targetHost: string;
  /** Persists the entered domain and moves status to "pending-dns". */
  onAddDomain: (domain: string) => void;
  /** Re-runs DNS verification. UI doesn't transition state itself — the
   *  parent owns that after the server result. */
  onCheckStatus: () => void;
  /** Removes the custom domain entirely. Returns to "none". */
  onRemove: () => void;
  /** True while a server call is in-flight. Disables actions. */
  pending?: boolean;
  className?: string;
}

/**
 * §10 #3 + §4 Phase 2 deliverable 2E. Custom-domain wiring is a *must-have*
 * for the first paying tenant — path-based URLs read as provisional and an
 * agency won't hand off `client.jabwp.app/acme/` as the final URL.
 *
 * State machine (mocked here; engineering swaps in real verification):
 *
 *   none  ─add→  pending-dns  ─check→  verified  ─wait-cert→  active
 *                   ↑   ↓                              ↓
 *                   └── error / cert-failure ──────────┘
 *
 * The DNS instructions surface inline once a domain is entered — agencies
 * have to forward this to whoever manages their client's domain registrar,
 * so the values (host + target) need to be copy-pasteable and unambiguous.
 */
export function CustomDomainCard({
  state,
  targetHost,
  onAddDomain,
  onCheckStatus,
  onRemove,
  pending = false,
  className,
}: CustomDomainCardProps) {
  const [domainInput, setDomainInput] = useState("");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = domainInput.trim().toLowerCase();
    if (!trimmed || pending) return;
    onAddDomain(trimmed);
    setDomainInput("");
  }

  if (state.status === "none") {
    return (
      <div className={cn("space-y-3", className)}>
        <div>
          <p className="text-sm font-semibold text-slate-900">Custom domain</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Point your client&apos;s domain (e.g. <code className="font-mono">acmecoffee.com</code>) at this
            site. Recommended before the final hand-off.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <Field
              label="Domain"
              labelHidden
              placeholder="acmecoffee.com"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button
            type="submit"
            disabled={!domainInput.trim() || pending}
            loading={pending}
            loadingText="Adding…"
          >
            Add domain
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">Custom domain</p>
          <p className="mt-0.5 truncate font-mono text-sm text-slate-700">
            {state.domain}
          </p>
        </div>
        <DomainStatusBadge status={state.status} />
      </div>

      {state.status === "pending-dns" && (
        <DnsInstructions
          domain={state.domain!}
          targetHost={targetHost}
          lastCheckedAt={state.lastCheckedAt}
          error={state.error}
        />
      )}

      {state.status === "verified" && (
        <Alert tone="info">
          DNS verified. We&apos;re provisioning the SSL certificate now — this
          usually takes a few minutes. The domain will go active automatically.
        </Alert>
      )}

      {state.status === "active" && (
        <Alert tone="success">
          Live at{" "}
          <a
            href={`https://${state.domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono font-medium underline"
          >
            https://{state.domain}
          </a>
          . Hand this URL to your client.
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
        <p className="text-xs text-slate-500">
          {state.lastCheckedAt
            ? `Last checked ${formatRelative(state.lastCheckedAt)}`
            : "Not yet verified"}
        </p>
        <div className="flex items-center gap-2">
          {state.status === "pending-dns" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onCheckStatus}
              loading={pending}
              loadingText="Checking…"
            >
              Check status
            </Button>
          )}
          {!showRemoveConfirm ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowRemoveConfirm(true)}
            >
              Remove
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-slate-600">Remove this domain?</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRemoveConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  onRemove();
                  setShowRemoveConfirm(false);
                }}
              >
                Remove
              </Button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function DomainStatusBadge({ status }: { status: CustomDomainStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta.tone}>
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {meta.label}
    </Badge>
  );
}

const STATUS_META: Record<
  Exclude<CustomDomainStatus, "none">,
  {
    tone: "neutral" | "warning" | "info" | "success";
    label: string;
    pulse: boolean;
  }
> & { none: { tone: "neutral"; label: string; pulse: boolean } } = {
  none: { tone: "neutral", label: "No domain", pulse: false },
  "pending-dns": { tone: "warning", label: "Pending DNS", pulse: true },
  verified: { tone: "info", label: "Issuing SSL", pulse: true },
  active: { tone: "success", label: "Active", pulse: false },
};

function DnsInstructions({
  domain,
  targetHost,
  lastCheckedAt,
  error,
}: {
  domain: string;
  targetHost: string;
  lastCheckedAt?: Date;
  error?: string;
}) {
  // Apex (acmecoffee.com) needs an A record because CNAME at the apex is
  // disallowed by DNS. www / true subdomains can CNAME directly. We surface
  // both recipes so the agency forwards the right one to the registrar.
  //
  // Detection has to account for compound TLDs — naive `parts.length === 2`
  // misclassifies acmecoffee.co.uk (3 parts) as a subdomain and would emit
  // CNAME acmecoffee → target, which is invalid at the zone apex. The
  // compound-TLD set below covers the most common cases; the long tail
  // (rare ccTLDs, Public Suffix List edge cases) can be handled in support
  // — better to ship a "this might be wrong, talk to us" disclaimer than a
  // wrong record confidently.
  const apex = isApexDomain(domain);

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
      <p className="font-semibold text-slate-900">Add these DNS records</p>
      <p className="mt-1 text-xs text-slate-600">
        Forward this to whoever manages <code className="font-mono">{domain}</code> at
        the registrar (GoDaddy, Cloudflare, etc.).
      </p>

      <div className="mt-3 space-y-2">
        {apex ? (
          <>
            <DnsRow type="A" host="@" value={targetHost} />
            <DnsRow type="CNAME" host="www" value={targetHost} />
          </>
        ) : (
          <DnsRow
            type="CNAME"
            host={domain.split(".")[0]!}
            value={targetHost}
          />
        )}
      </div>

      {error && (
        <p className="mt-3 rounded border border-danger/30 bg-danger-muted px-2 py-1.5 text-xs text-danger-strong">
          {error}
        </p>
      )}

      {!error && lastCheckedAt && (
        <p className="mt-3 text-xs text-slate-500">
          DNS hasn&apos;t propagated yet. This can take a few minutes — up to a
          few hours depending on the registrar.
        </p>
      )}
    </div>
  );
}

/**
 * Common compound TLDs that span two labels (e.g. `.co.uk`, `.com.au`).
 * The full Public Suffix List is ~11k entries — this set covers the
 * majority of agency-relevant ccTLDs. Anything outside it falls back to
 * "treat the last two labels as the registrable domain," which is the
 * right answer for the vast majority of single-label TLDs (`.com`,
 * `.io`, `.ca`, etc.).
 */
const COMPOUND_TLDS: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.mx",
  "co.za",
  "co.in",
  "co.kr",
  "com.tw",
]);

function isApexDomain(domain: string): boolean {
  const parts = domain.toLowerCase().split(".");
  if (parts.length <= 1) return true;
  if (parts.length === 2) return true;
  if (parts.length === 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (COMPOUND_TLDS.has(lastTwo)) return true;
  }
  return false;
}

function DnsRow({
  type,
  host,
  value,
}: {
  type: "A" | "CNAME";
  host: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[5rem_1fr_2fr] items-center gap-3 rounded border border-slate-200 bg-white px-3 py-2 font-mono text-xs">
      <span className="font-semibold text-slate-700">{type}</span>
      <span className="text-slate-700">{host}</span>
      <span className="truncate text-slate-600">{value}</span>
    </div>
  );
}
