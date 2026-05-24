"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";

/**
 * Confidence-threshold review surface for Stage 2 design extraction.
 *
 * Per design plan §15 and transition doc §10 priority #4, every AI-derived
 * field carries a numeric confidence + reasoning that the workspace should
 * surface so:
 *   - Agencies can audit *why* the AI picked one color/font over another
 *     (trust + debuggability)
 *   - Low-confidence fields get a "review this" affordance instead of
 *     silently degrading the generated output
 *
 * Three tiers:
 *   - ≥ 0.7 — confidence chip, normal styling
 *   - 0.4–0.7 — warning chip + "Review this" hint; field is still used
 *   - < 0.4 — danger chip; field is structurally there but the user is
 *             strongly nudged to override before generation runs against it
 *
 * Editing isn't wired here yet — first iteration is read + reasoning
 * disclosure. The "Override" affordance lands in a follow-up when the
 * generation worker actually consumes these columns.
 */

/**
 * Public-shape of the persisted `projects.design_tokens` payload — mirrors
 * DesignAnalysis minus `personality`. Defined locally instead of imported
 * from scrape-agent to avoid pulling the `server-only` module into a
 * Client Component's import graph (even via `import type`, the dev-time
 * tooling can complain).
 */
export interface DesignTokensPayload {
  colors: {
    primary: ConfidenceField<string>;
    secondary: ConfidenceField<string | null>;
    accent: ConfidenceField<string | null>;
  };
  typography: {
    heading: ConfidenceField<string | null>;
    body: ConfidenceField<string | null>;
  };
  logo: {
    src: string | null;
    confidence: number;
    reasoning: string;
  };
  buttonPair: {
    primary: ConfidenceField<string | null>;
    secondary: ConfidenceField<string | null>;
  };
}

export interface PersonalityPayload {
  tone: ConfidenceField<string>;
  energy: ConfidenceField<"low" | "medium" | "high">;
  audience: ConfidenceField<string>;
}

interface ConfidenceField<T> {
  value: T;
  confidence: number;
  reasoning: string;
}

export interface DesignTokensReviewProps {
  tokens: DesignTokensPayload | null;
  personality: PersonalityPayload | null;
}

const REVIEW_THRESHOLD = 0.7;
const REFUSE_THRESHOLD = 0.4;

export function DesignTokensReview({
  tokens,
  personality,
}: DesignTokensReviewProps) {
  if (!tokens && !personality) {
    return <DesignTokensPending />;
  }

  // At least one column is populated; render the parts we have. The
  // worker writes both atomically, so a half-populated state is rare —
  // but if it happens we don't want a crash.
  return (
    <Card>
      <CardHeader>
        <CardTitle>Design context</CardTitle>
        <p className="mt-1 text-xs text-gry-d">
          What the AI inferred from your site&apos;s public homepage. Low-
          confidence fields are flagged for review — we&apos;ll generate
          against them, but you should sanity-check the choice.
        </p>
      </CardHeader>
      <CardBody className="space-y-6">
        {tokens && (
          <>
            <ColorsSection colors={tokens.colors} />
            <TypographySection typography={tokens.typography} />
            <LogoSection logo={tokens.logo} />
            <ButtonsSection buttons={tokens.buttonPair} />
          </>
        )}
        {personality && <PersonalitySection personality={personality} />}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function ColorsSection({ colors }: { colors: DesignTokensPayload["colors"] }) {
  return (
    <SectionFrame title="Colors">
      <div className="grid gap-3 sm:grid-cols-3">
        <ConfidenceRow
          label="Primary"
          confidence={colors.primary.confidence}
          reasoning={colors.primary.reasoning}
          preview={<ColorSwatch hex={colors.primary.value} />}
          value={colors.primary.value}
        />
        <ConfidenceRow
          label="Secondary"
          confidence={colors.secondary.confidence}
          reasoning={colors.secondary.reasoning}
          preview={<ColorSwatch hex={colors.secondary.value} />}
          value={colors.secondary.value ?? "—"}
        />
        <ConfidenceRow
          label="Accent"
          confidence={colors.accent.confidence}
          reasoning={colors.accent.reasoning}
          preview={<ColorSwatch hex={colors.accent.value} />}
          value={colors.accent.value ?? "—"}
        />
      </div>
    </SectionFrame>
  );
}

function TypographySection({
  typography,
}: {
  typography: DesignTokensPayload["typography"];
}) {
  return (
    <SectionFrame title="Typography">
      <div className="grid gap-3 sm:grid-cols-2">
        <ConfidenceRow
          label="Heading"
          confidence={typography.heading.confidence}
          reasoning={typography.heading.reasoning}
          preview={<FontSample family={typography.heading.value} weight={700} />}
          value={typography.heading.value ?? "—"}
        />
        <ConfidenceRow
          label="Body"
          confidence={typography.body.confidence}
          reasoning={typography.body.reasoning}
          preview={<FontSample family={typography.body.value} weight={400} />}
          value={typography.body.value ?? "—"}
        />
      </div>
    </SectionFrame>
  );
}

function LogoSection({ logo }: { logo: DesignTokensPayload["logo"] }) {
  return (
    <SectionFrame title="Logo">
      <ConfidenceRow
        label="Selected image"
        confidence={logo.confidence}
        reasoning={logo.reasoning}
        preview={
          logo.src ? (
            <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded border border-bord bg-bg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logo.src}
                alt="Detected logo"
                className="max-h-10 max-w-10 object-contain"
              />
            </span>
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-bord text-xs text-gry-d">
              none
            </span>
          )
        }
        value={logo.src ?? "no logo detected"}
        valueIsUrl={Boolean(logo.src)}
      />
    </SectionFrame>
  );
}

function ButtonsSection({
  buttons,
}: {
  buttons: DesignTokensPayload["buttonPair"];
}) {
  return (
    <SectionFrame title="Call-to-action copy">
      <div className="grid gap-3 sm:grid-cols-2">
        <ConfidenceRow
          label="Primary CTA"
          confidence={buttons.primary.confidence}
          reasoning={buttons.primary.reasoning}
          preview={
            buttons.primary.value ? (
              <span className="inline-flex items-center rounded-md bg-teal px-3 py-1.5 text-xs font-medium text-white">
                {buttons.primary.value}
              </span>
            ) : (
              <span className="text-xs text-gry-d">none detected</span>
            )
          }
          value={buttons.primary.value ?? "—"}
        />
        <ConfidenceRow
          label="Secondary CTA"
          confidence={buttons.secondary.confidence}
          reasoning={buttons.secondary.reasoning}
          preview={
            buttons.secondary.value ? (
              <span className="inline-flex items-center rounded-md border border-bord px-3 py-1.5 text-xs font-medium text-gry">
                {buttons.secondary.value}
              </span>
            ) : (
              <span className="text-xs text-gry-d">none detected</span>
            )
          }
          value={buttons.secondary.value ?? "—"}
        />
      </div>
    </SectionFrame>
  );
}

function PersonalitySection({
  personality,
}: {
  personality: PersonalityPayload;
}) {
  return (
    <SectionFrame title="Brand personality">
      <div className="grid gap-3 sm:grid-cols-3">
        <ConfidenceRow
          label="Tone"
          confidence={personality.tone.confidence}
          reasoning={personality.tone.reasoning}
          preview={<Badge tone="info">{personality.tone.value}</Badge>}
          value={personality.tone.value}
        />
        <ConfidenceRow
          label="Energy"
          confidence={personality.energy.confidence}
          reasoning={personality.energy.reasoning}
          preview={<Badge tone="neutral">{personality.energy.value}</Badge>}
          value={personality.energy.value}
        />
        <ConfidenceRow
          label="Audience"
          confidence={personality.audience.confidence}
          reasoning={personality.audience.reasoning}
          preview={null}
          value={personality.audience.value}
        />
      </div>
    </SectionFrame>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function SectionFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gry-d">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ConfidenceRow({
  label,
  confidence,
  reasoning,
  preview,
  value,
  valueIsUrl,
}: {
  label: string;
  confidence: number;
  reasoning: string;
  preview: React.ReactNode | null;
  value: string;
  valueIsUrl?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tier = confidenceTier(confidence);

  return (
    <div className="rounded-md border border-bord bg-bg p-3">
      <div className="flex items-start gap-3">
        {preview && <div className="shrink-0">{preview}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-gry-d">{label}</span>
            <ConfidenceBadge confidence={confidence} tier={tier} />
          </div>
          <p
            className={cn(
              "mt-1 break-words text-sm text-wht",
              valueIsUrl && "font-mono text-xs",
            )}
            title={value}
          >
            {value}
          </p>
        </div>
      </div>

      {tier === "review" && (
        <Alert
          tone="warning"
          className="mt-2 py-2 text-xs"
          title="Review this"
        >
          The AI wasn&apos;t confident. We&apos;ll use it for generation, but
          you should sanity-check before publishing.
        </Alert>
      )}
      {tier === "refuse" && (
        <Alert
          tone="danger"
          className="mt-2 py-2 text-xs"
          title="Strongly recommend overriding"
        >
          Confidence is too low to rely on. The generator omits this field from
          its prompt — override it before running generation if you want it
          applied.
        </Alert>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-xs font-medium text-teal hover:text-teal-hover focus-visible:outline-none focus-visible:underline"
        aria-expanded={open}
      >
        {open ? "Hide reasoning" : "Why this?"}
      </button>
      {open && (
        // max-h + overflow-y-auto bounds runaway reasoning text. The LLM
        // is prompt-budgeted to short citations but a future prompt
        // change or model regression could produce a multi-KB
        // explanation; capping height here avoids a single field
        // dominating the page.
        <p className="mt-2 max-h-32 overflow-y-auto rounded bg-surf px-3 py-2 text-xs text-gry">
          {reasoning}
        </p>
      )}
    </div>
  );
}

type ConfidenceTier = "high" | "review" | "refuse";

function confidenceTier(c: number): ConfidenceTier {
  if (c < REFUSE_THRESHOLD) return "refuse";
  if (c < REVIEW_THRESHOLD) return "review";
  return "high";
}

function ConfidenceBadge({
  confidence,
  tier,
}: {
  confidence: number;
  tier: ConfidenceTier;
}) {
  const pct = Math.round(confidence * 100);
  if (tier === "refuse") {
    return <Badge tone="danger">{pct}%</Badge>;
  }
  if (tier === "review") {
    return <Badge tone="warning">{pct}%</Badge>;
  }
  return <Badge tone="success">{pct}%</Badge>;
}

function ColorSwatch({ hex }: { hex: string | null }) {
  if (!hex) {
    return (
      <span className="block h-10 w-10 rounded border border-dashed border-bord text-center text-[10px] leading-10 text-gry-d">
        —
      </span>
    );
  }
  return (
    <span
      className="block h-10 w-10 rounded border border-bord"
      style={{ backgroundColor: hex }}
      aria-label={`Color ${hex}`}
    />
  );
}

function FontSample({
  family,
  weight,
}: {
  family: string | null;
  weight: number;
}) {
  if (!family) {
    return (
      <span className="text-base text-gry-d">—</span>
    );
  }
  return (
    <span
      className="block text-2xl leading-none text-wht"
      style={{ fontFamily: family, fontWeight: weight }}
    >
      Aa
    </span>
  );
}

function DesignTokensPending() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Design context</CardTitle>
      </CardHeader>
      <CardBody>
        <Alert tone="info" title="Studying your site's design">
          We&apos;re extracting colors, fonts, and brand personality from your
          homepage. This usually takes about a minute — refresh to see the
          results. If it doesn&apos;t finish, re-run the WordPress probe.
        </Alert>
      </CardBody>
    </Card>
  );
}
