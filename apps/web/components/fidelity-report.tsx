"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { PreviewCompare, type PreviewPane } from "@/components/preview-compare";

export type FidelityCheckStatus = "matched" | "near-match" | "miss";

export interface FidelityCheck {
  id: string;
  /** Short, human label — "Hero structure", "Section order", "Color palette". */
  label: string;
  status: FidelityCheckStatus;
  /** Optional one-line clarification — "indigo-600 within Δ of original blue". */
  detail?: string;
}

export interface FidelityReportProps {
  /** WP-rendered original — the source of truth the rebuild was measured against. */
  original: PreviewPane;
  /** AI-generated Jab output being scored. */
  generated: PreviewPane;
  /** The dimensions we checked. Order is the order they render. */
  checks: FidelityCheck[];
  /** Optional title — defaults to "Fidelity report". */
  title?: string;
  /** Highlight overlay state (visual-diff toggle). Engineering wires the overlay; the UI just owns the affordance. */
  highlightActive?: boolean;
  onToggleHighlight?: () => void;
  /** Queue another generation seeded with the diff as context. */
  onIterate?: () => void;
  /** Promote the generated version. Usually opens the PublishConfirmModal upstream. */
  onAccept?: () => void;
  className?: string;
}

/**
 * §4 Phase 3 + §10 #7 + transition doc §5 Phase 3 fidelity approach. Renders
 * the visual-diff between the WP original and the AI-generated Jab output,
 * with a list of matched/missed dimensions and explicit "iterate or accept"
 * action affordances.
 *
 * Honest framing is load-bearing: copy says "structurally similar," never
 * "pixel-exact." A per-check list ("Hero structure matched · Color palette
 * within Δ") makes the claim auditable instead of a single opaque score.
 *
 * Composes over PreviewCompare so the breakpoint toggle, sandboxed iframes,
 * and shared device size all live in one place.
 */
export function FidelityReport({
  original,
  generated,
  checks,
  title = "Fidelity report",
  highlightActive = false,
  onToggleHighlight,
  onIterate,
  onAccept,
  className,
}: FidelityReportProps) {
  const matched = checks.filter((c) => c.status === "matched").length;
  const total = checks.length;
  const tone = pickSummaryTone(checks);

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardBody className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Faithful means structurally similar — not pixel-exact. Review the
              dimensions below, then iterate or accept.
            </p>
          </div>
          <Badge tone={tone}>
            {matched} of {total} matched
          </Badge>
        </header>

        <PreviewCompare
          before={original}
          after={generated}
          caption={
            highlightActive
              ? "Highlighting structural and color differences between the two versions."
              : undefined
          }
        />

        <ul className="space-y-2">
          {checks.map((check) => (
            <li
              key={check.id}
              className="flex items-start gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <CheckGlyph status={check.status} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">{check.label}</p>
                {check.detail && (
                  <p className="mt-0.5 text-xs text-slate-500">{check.detail}</p>
                )}
              </div>
              <CheckLabel status={check.status} />
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleHighlight}
            disabled={!onToggleHighlight}
          >
            {highlightActive ? "Hide differences" : "Show what changed"}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onIterate}
              disabled={!onIterate}
            >
              Iterate further
            </Button>
            <Button size="sm" onClick={onAccept} disabled={!onAccept}>
              Accept &amp; publish
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function pickSummaryTone(
  checks: FidelityCheck[],
): "success" | "warning" | "danger" {
  if (checks.length === 0) return "warning";
  if (checks.some((c) => c.status === "miss")) return "danger";
  if (checks.some((c) => c.status === "near-match")) return "warning";
  return "success";
}

const CHECK_META: Record<
  FidelityCheckStatus,
  { tone: "success" | "warning" | "danger"; label: string; glyph: string }
> = {
  matched: { tone: "success", label: "Matched", glyph: "✓" },
  "near-match": { tone: "warning", label: "Close", glyph: "≈" },
  miss: { tone: "danger", label: "Differs", glyph: "✗" },
};

function CheckGlyph({ status }: { status: FidelityCheckStatus }) {
  const meta = CHECK_META[status];
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        meta.tone === "success" && "bg-success-muted text-success-strong",
        meta.tone === "warning" && "bg-warning-muted text-warning-strong",
        meta.tone === "danger" && "bg-danger-muted text-danger-strong",
      )}
    >
      {meta.glyph}
    </span>
  );
}

function CheckLabel({ status }: { status: FidelityCheckStatus }) {
  const meta = CHECK_META[status];
  return (
    <Badge tone={meta.tone} className="shrink-0">
      {meta.label}
    </Badge>
  );
}
