"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { OnboardingShell } from "@/components/ui/onboarding-shell";
import { IntentPicker, type ProjectIntent } from "@/components/intent-picker";
import {
  OwnershipPicker,
  type OwnershipMode,
  type WPContentType,
} from "@/components/ownership-picker";
import { MigrationConfirmModal } from "@/components/migration-confirm-modal";

export interface OnboardingWizardData {
  intent: ProjectIntent;
  ownership: Record<string, OwnershipMode>;
}

export interface OnboardingConnectCredentials {
  wpUrl: string;
  wpUsername: string;
  wpAppPassword: string;
}

export type OnboardingConnectResult =
  | { ok: true; contentTypes: WPContentType[] }
  | { ok: false; error: string };

export interface OnboardingWizardProps {
  /**
   * The WordPress URL this wizard operates on. Required — it's what was
   * pasted at §12 step 1 (`/preview`) and what every step here is scoped to.
   * Shown read-only in the shell so the user always sees the site context.
   */
  wpUrl: string;
  /** Pre-filled intent — usually defaulted from the §12 step 4 selection. */
  initialIntent?: ProjectIntent;
  /**
   * Submits stage-2 connect. The parent runs the WP probe (auth +
   * `/wp-json/jab/v1/manifest`), persists credentials server-side, and
   * returns the full content-types catalog from the plugin manifest. The
   * wizard advances to the ownership step on `{ ok: true }`; on `{ ok: false }`
   * it stays on the connect step and surfaces `error` as an Alert.
   *
   * This is the boundary where stage-1 (public REST, partial view) becomes
   * stage-2 (plugin + auth, full view including drafts + ACF + private CPTs).
   * Ownership lives AFTER this on purpose — picking ownership against the
   * partial stage-1 catalog leads to commitments the user can't fully see.
   */
  onConnect: (
    credentials: OnboardingConnectCredentials,
  ) => Promise<OnboardingConnectResult>;
  /**
   * Final commit. Persists intent + ownership and (typically) routes the
   * user to their project workspace.
   */
  onComplete: (data: OnboardingWizardData) => void | Promise<void>;
  /**
   * Download URL for the Jab plugin .zip. Defaults to a placeholder path;
   * production should point at the latest release artifact (a stable
   * `/downloads/jab-plugin-latest.zip` or the WP.org listing once published).
   */
  pluginDownloadUrl?: string;
  /**
   * Optional callback to verify the plugin is reachable on the user's site
   * (parent hits `/wp-json/jab/v1/` on the wpUrl). Surfaced as the
   * "Verify install" affordance on the plugin step.
   */
  onVerifyPlugin?: () => Promise<{ ok: boolean; message?: string }>;
}

type StepIndex = 0 | 1 | 2 | 3;

const STEP_LABELS = ["Intent", "Install plugin", "Connect", "Ownership"];
const LAST_STEP: StepIndex = 3;

/**
 * §12 steps 4 → 6 orchestration. Each step is self-contained inside the
 * shell; the wizard owns the cross-step state so a user backtracking from
 * step 6 to 4 doesn't lose their ownership selections.
 *
 * Steps 1–3 (paste URL → public preview → signup) live outside this wizard
 * — they're the pre-auth `/preview` flow that promotes an anonymous draft
 * into the user's account. By the time this component mounts, the project
 * row exists and the wizard's job is to layer intent + ownership + the
 * live-data connection onto it.
 */
export function OnboardingWizard({
  wpUrl,
  initialIntent = "faithful",
  onConnect,
  onComplete,
  pluginDownloadUrl = "/downloads/jab-plugin-latest.zip",
  onVerifyPlugin,
}: OnboardingWizardProps) {
  const [stepIndex, setStepIndex] = useState<StepIndex>(0);
  const [intent, setIntent] = useState<ProjectIntent>(initialIntent);
  // Content types and the ownership map are populated AFTER the connect step
  // returns the stage-2 catalog. Initial empty; ownership defaults are seeded
  // from `recommendedMode` once contentTypes arrive.
  const [contentTypes, setContentTypes] = useState<WPContentType[]>([]);
  const [ownership, setOwnership] = useState<Record<string, OwnershipMode>>({});
  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [pendingMigration, setPendingMigration] = useState<{
    type: WPContentType;
    confirm: () => void;
  } | null>(null);
  // Plugin-step verification state.
  const [verifyingPlugin, setVerifyingPlugin] = useState(false);
  const [pluginVerifyResult, setPluginVerifyResult] = useState<
    { ok: boolean; message?: string } | null
  >(null);
  // Connect-step in-flight + error state.
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | undefined>();
  // Ownership-step submission state (the final persist).
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | undefined>();

  const displayHost = (() => {
    try {
      return new URL(wpUrl).hostname.replace(/^www\./, "");
    } catch {
      return wpUrl;
    }
  })();

  const steps = STEP_LABELS.map((label, idx) => ({
    label,
    status:
      idx < stepIndex
        ? ("done" as const)
        : idx === stepIndex
          ? ("current" as const)
          : ("pending" as const),
  }));

  function goNext() {
    if (stepIndex < LAST_STEP) setStepIndex((stepIndex + 1) as StepIndex);
  }

  function goBack() {
    if (stepIndex === 0) return;
    // Clear step-scoped errors when navigating away from the step that owns
    // them — otherwise a stale "wrong password" alert reappears the moment
    // the user nav-forwards back into the connect step, before they've
    // touched anything.
    if (stepIndex === 2) setConnectError(undefined);
    if (stepIndex === 3) setFinishError(undefined);
    setStepIndex((stepIndex - 1) as StepIndex);
  }

  async function handleConnectSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wpUsername.trim() || !wpAppPassword.trim() || connecting) return;
    setConnectError(undefined);
    setConnecting(true);
    try {
      const result = await onConnect({
        wpUrl,
        wpUsername: wpUsername.trim(),
        wpAppPassword: wpAppPassword.trim(),
      });
      if (!result.ok) {
        setConnectError(result.error);
        return;
      }
      setContentTypes(result.contentTypes);
      setOwnership(
        Object.fromEntries(
          result.contentTypes.map((t) => [t.slug, t.recommendedMode]),
        ),
      );
      setStepIndex(3);
    } finally {
      setConnecting(false);
    }
  }

  async function handleFinish() {
    if (finishing) return;
    setFinishError(undefined);
    setFinishing(true);
    try {
      await onComplete({ intent, ownership });
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinishing(false);
    }
  }

  return (
    <OnboardingShell
      title="Finish setting up this project"
      description={
        <>
          Four quick steps for{" "}
          <code className="rounded bg-elev px-1.5 py-0.5 font-mono text-sm text-wht">
            {displayHost}
          </code>
          : intent, install the plugin, connect, then decide where each
          content type lives.
        </>
      }
      steps={steps}
    >
      {stepIndex === 0 && (
        <StepFrame
          headline="Pick a project intent"
          body="This shapes how closely the AI sticks to the original layout. You can change it later."
          primaryLabel="Continue →"
          primaryDisabled={false}
          onPrimary={goNext}
        >
          <IntentPicker value={intent} onChange={setIntent} />
        </StepFrame>
      )}

      {stepIndex === 1 && (
        <StepFrame
          headline="Install the Jab plugin on your client's WordPress"
          body="The plugin is the bridge between WordPress and Jab. It's a small Composer-installable plugin — your client's site keeps running as-is; the plugin just exposes the endpoints we need to read drafts, custom fields, and post types."
          secondaryLabel="← Back"
          onSecondary={goBack}
          primaryLabel="I've installed it — continue →"
          primaryDisabled={false}
          onPrimary={goNext}
        >
          <div className="space-y-4">
            <PluginInstallInstructions
              pluginDownloadUrl={pluginDownloadUrl}
              wpUrl={wpUrl}
            />

            {onVerifyPlugin && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-bord bg-surf px-3 py-2">
                <div className="min-w-0 text-xs text-gry">
                  Already installed? Verify the plugin is reachable before you
                  continue.
                </div>
                <div className="flex items-center gap-2">
                  {pluginVerifyResult && (
                    <span
                      className={cn(
                        "text-xs font-medium",
                        pluginVerifyResult.ok
                          ? "text-teal"
                          : "text-red",
                      )}
                    >
                      {pluginVerifyResult.ok
                        ? "✓ Plugin detected"
                        : (pluginVerifyResult.message ?? "Not found")}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={verifyingPlugin}
                    loadingText="Checking…"
                    onClick={async () => {
                      setVerifyingPlugin(true);
                      setPluginVerifyResult(null);
                      try {
                        const result = await onVerifyPlugin();
                        setPluginVerifyResult(result);
                      } finally {
                        setVerifyingPlugin(false);
                      }
                    }}
                  >
                    Verify install
                  </Button>
                </div>
              </div>
            )}
          </div>
        </StepFrame>
      )}

      {stepIndex === 2 && (
        <StepFrame
          headline="Connect for the live data sync"
          body="The application password authenticates against the plugin's endpoints. Generate one at Users → Profile → Application Passwords in wp-admin. After this we'll have the full content catalog and you can assign ownership."
          secondaryLabel="← Back"
          onSecondary={goBack}
          asForm
          onSubmit={handleConnectSubmit}
          primaryLabel="Connect →"
          primaryDisabled={!wpUsername.trim() || !wpAppPassword.trim()}
          primaryLoading={connecting}
          primaryLoadingText="Connecting…"
          primaryType="submit"
        >
          {connectError && <Alert tone="danger">{connectError}</Alert>}
          <div className="rounded-md border border-bord bg-surf px-3 py-2 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-gry-d">
              Connecting to
            </p>
            <p className="mt-1 truncate font-mono text-wht">{wpUrl}</p>
          </div>
          <Field
            label="WordPress username"
            placeholder="admin@clientsite.com"
            value={wpUsername}
            onChange={(e) => setWpUsername(e.target.value)}
            required
            autoComplete="username"
            disabled={connecting}
          />
          <Field
            label="Application password"
            type="password"
            placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            value={wpAppPassword}
            onChange={(e) => setWpAppPassword(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
            hint="Not your wp-admin password — generate a dedicated app password."
            disabled={connecting}
          />
        </StepFrame>
      )}

      {stepIndex === 3 && (
        <StepFrame
          headline="Where does each content type live?"
          body="Pages tend to belong in Jab (they're bespoke marketing surfaces). Collections like blog posts usually stay in WordPress where your client already edits them. You can change this later from Connections."
          secondaryLabel="← Back"
          onSecondary={goBack}
          primaryLabel="Finish setup →"
          primaryDisabled={contentTypes.length === 0}
          primaryLoading={finishing}
          primaryLoadingText="Saving…"
          onPrimary={handleFinish}
        >
          {finishError && <Alert tone="danger">{finishError}</Alert>}
          <p className="rounded-md border border-teal/30 bg-teal/10 px-3 py-2 text-xs text-teal">
            ✓ Connected to {displayHost}. We found{" "}
            {contentTypes.length} content type
            {contentTypes.length === 1 ? "" : "s"} — including drafts and
            custom fields.
          </p>
          <OwnershipPicker
            types={contentTypes}
            value={ownership}
            onChange={(slug, next) =>
              setOwnership((prev) => ({ ...prev, [slug]: next }))
            }
            onMigrationRequired={(type, confirm) =>
              setPendingMigration({ type, confirm })
            }
          />
        </StepFrame>
      )}

      <MigrationConfirmModal
        type={pendingMigration?.type ?? null}
        onCancel={() => setPendingMigration(null)}
        onConfirm={() => {
          pendingMigration?.confirm();
          setPendingMigration(null);
        }}
      />
    </OnboardingShell>
  );
}

interface StepFrameProps {
  headline: string;
  body: string;
  children: React.ReactNode;
  secondaryLabel?: string;
  onSecondary?: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryLoadingText?: string;
  primaryType?: "button" | "submit";
  onPrimary?: () => void;
  asForm?: boolean;
  onSubmit?: (e: React.FormEvent) => void;
}

function StepFrame({
  headline,
  body,
  children,
  secondaryLabel,
  onSecondary,
  primaryLabel,
  primaryDisabled = false,
  primaryLoading = false,
  primaryLoadingText,
  primaryType = "button",
  onPrimary,
  asForm = false,
  onSubmit,
}: StepFrameProps) {
  const inner = (
    <Card>
      <CardBody className="space-y-5">
        <header>
          <h2 className="text-lg font-semibold text-wht">{headline}</h2>
          <p className="mt-1 text-sm text-gry">{body}</p>
        </header>

        <div className="space-y-4">{children}</div>

        <div className="flex items-center justify-between gap-3 border-t border-bord pt-4">
          {secondaryLabel && onSecondary ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onSecondary}
              disabled={primaryLoading}
            >
              {secondaryLabel}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type={primaryType}
            onClick={primaryType === "button" ? onPrimary : undefined}
            disabled={primaryDisabled}
            loading={primaryLoading}
            loadingText={primaryLoadingText}
          >
            {primaryLabel}
          </Button>
        </div>
      </CardBody>
    </Card>
  );

  if (asForm) {
    return (
      <form onSubmit={onSubmit} noValidate>
        {inner}
      </form>
    );
  }
  return inner;
}

function PluginInstallInstructions({
  pluginDownloadUrl,
  wpUrl,
}: {
  pluginDownloadUrl: string;
  wpUrl: string;
}) {
  const wpAdminUrl = (() => {
    try {
      return new URL("/wp-admin/plugin-install.php", wpUrl).toString();
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md border border-bord bg-bg p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-gry-d">
          Option 1 — Upload via wp-admin
        </p>
        <ol className="mt-3 space-y-2 text-gry">
          <li className="flex items-start gap-3">
            <StepNumber n={1} />
            <span className="flex-1">
              <a
                href={pluginDownloadUrl}
                className="font-medium text-teal hover:text-brand-hover"
                download
              >
                Download the plugin .zip ↓
              </a>
            </span>
          </li>
          <li className="flex items-start gap-3">
            <StepNumber n={2} />
            <span className="flex-1">
              {wpAdminUrl ? (
                <>
                  In your client&apos;s wp-admin, go to{" "}
                  <a
                    href={wpAdminUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-gry underline-offset-2 hover:underline"
                  >
                    Plugins → Add New → Upload Plugin
                  </a>
                </>
              ) : (
                <>
                  In your client&apos;s wp-admin, go to Plugins → Add New →
                  Upload Plugin
                </>
              )}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <StepNumber n={3} />
            <span className="flex-1">Upload the zip and activate.</span>
          </li>
        </ol>
      </div>

      <div className="rounded-md border border-bord bg-bg p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-gry-d">
          Option 2 — Composer (Composer-managed installs only)
        </p>
        <pre className="mt-3 overflow-x-auto rounded bg-bg px-3 py-2 font-mono text-xs text-gry-d">
          composer require jab/wp-headless-plugin
        </pre>
        <p className="mt-2 text-xs text-gry-d">
          Then activate in wp-admin → Plugins, or via WP-CLI:{" "}
          <code className="rounded bg-elev px-1 py-0.5">
            wp plugin activate jab-wp-headless
          </code>
          .
        </p>
      </div>

      <p className="text-xs text-gry-d">
        The plugin only exposes read endpoints for the content types you
        chose. It doesn&apos;t change how wp-admin behaves and uninstalling it
        won&apos;t affect existing WordPress content.
      </p>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal/10 text-xs font-semibold text-teal">
      {n}
    </span>
  );
}
