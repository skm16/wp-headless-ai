import type { DiagnosticsReport, DiagnosticsCheck } from "@/lib/jab/diagnostics";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const TONE: Record<DiagnosticsCheck["severity"], "success" | "warning" | "danger"> = {
  pass: "success",
  warn: "warning",
  fail: "danger",
};

/**
 * Renders the plugin's /wp-json/jab/v1/diagnostics report (v0.7.1+) as a
 * connector-health card: the version + summary line in the header, then one
 * row per health check with a severity badge. Used in onboarding after a
 * successful plugin verify so connector misconfiguration is visible up front.
 */
export function ConnectorHealthPanel({ report }: { report: DiagnosticsReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connector health</CardTitle>
        <span className="font-mono text-[11px] text-gry">
          plugin v{report.plugin_version} · {report.summary.pass} pass ·{" "}
          {report.summary.warn} warn · {report.summary.fail} fail
        </span>
      </CardHeader>
      <CardBody>
        <ul className="space-y-2">
          {report.checks.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm text-wht">{c.label}</div>
                <div className="text-xs text-gry">{c.message}</div>
              </div>
              <Badge tone={TONE[c.severity]}>{c.severity}</Badge>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
