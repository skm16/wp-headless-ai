"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import type { OwnershipMode } from "@/components/ownership-picker";

export type IterationMode = "content" | "design";

export interface IterationHistoryEntry {
  id: string;
  prompt: string;
  mode: IterationMode;
  deploymentLabel: string;
  createdAt: Date;
}

export interface IterationPanelProps {
  /** Ownership of the page being iterated. Determines whether content edits are enabled. */
  ownership: OwnershipMode;
  /** Generations remaining in the current period. Used in the helper caption. */
  generationsLeft: number;
  /** Recent iterations shown as a short history list. */
  history: IterationHistoryEntry[];
  /** Loading state during a pending iteration. Disables input + send. */
  pending?: boolean;
  /** Default mode shown when the panel mounts. Falls back to ownership-driven default. */
  defaultMode?: IterationMode;
  onSubmit: (prompt: string, mode: IterationMode) => void;
  className?: string;
}

const PLACEHOLDERS: Record<IterationMode, string> = {
  content: "Change the hero headline to 'Brooklyn-roasted, neighborhood-served'",
  design: "Make the hero full-bleed and use a warmer color palette",
};

const EXAMPLE_PROMPTS: Record<IterationMode, string[]> = {
  content: [
    "Update the hero headline to be shorter and more direct",
    "Add the client's phone number to the footer",
    "Replace the about copy with three short paragraphs",
  ],
  design: [
    "Make the hero full-bleed and use a warmer color palette",
    "Switch to a serif typeface for headlines",
    "Tighten the spacing between sections",
  ],
};

/**
 * §10 #9 + #12 + §13. Natural-language iteration input with an explicit
 * Content edit / Design edit toggle.
 *
 * Content edit → mutates the content_documents row, no Opus call, doesn't
 * count against quota. Only valid on Jab-managed pages.
 * Design edit → regenerates the component, Opus call, counts against quota.
 *
 * On WP-managed pages the Content edit option is disabled with explanatory
 * copy — content edits live in wp-admin for those types.
 */
export function IterationPanel({
  ownership,
  generationsLeft,
  history,
  pending = false,
  defaultMode,
  onSubmit,
  className,
}: IterationPanelProps) {
  const isWPManaged = ownership === "wp-managed";
  const effectiveDefault: IterationMode =
    defaultMode ?? (isWPManaged ? "design" : "content");
  const [mode, setMode] = useState<IterationMode>(effectiveDefault);
  const [prompt, setPrompt] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || pending) return;
    onSubmit(trimmed, mode);
    setPrompt("");
  }

  const quotaCaption =
    mode === "content"
      ? "Content edits mutate the page directly — no quota used."
      : `1 generation will be used · ${generationsLeft} left this period`;

  return (
    <Card className={className}>
      <CardBody>
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-wht">
                Refine this page
              </h3>
              <p className="mt-0.5 text-xs text-gry-d">
                Tell us what to change in plain English. We&apos;ll update the
                preview.
              </p>
            </div>
            <Segmented
              value={mode}
              onChange={setMode}
              size="sm"
              ariaLabel="Edit mode"
              options={[
                {
                  value: "content",
                  label: "Content edit",
                  disabled: isWPManaged,
                  description: isWPManaged
                    ? "Content edits happen in wp-admin for WP-managed pages"
                    : "Mutates the page document — no AI regeneration",
                },
                {
                  value: "design",
                  label: "Design edit",
                  description: "Regenerates the page with a new layout or style",
                },
              ]}
            />
          </div>

          {isWPManaged && mode === "design" && (
            <p className="rounded-md border border-blue/30 bg-blue/10 px-3 py-2 text-xs text-blue">
              This page is WP-managed. Content edits happen in wp-admin —
              design edits run here.
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={PLACEHOLDERS[mode]}
              disabled={pending}
              rows={3}
              className={cn(
                "block w-full resize-y rounded-md border border-bord px-3 py-2 text-sm text-wht transition-colors",
                "focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30",
                "disabled:cursor-not-allowed disabled:bg-surf disabled:text-gry-d",
              )}
            />
            <div className="flex items-center justify-between gap-3">
              <p
                className={cn(
                  "text-xs",
                  mode === "design" && generationsLeft === 0
                    ? "text-red"
                    : "text-gry-d",
                )}
              >
                {quotaCaption}
              </p>
              <Button
                type="submit"
                size="sm"
                loading={pending}
                loadingText="Generating…"
                disabled={
                  !prompt.trim() ||
                  (mode === "design" && generationsLeft === 0)
                }
              >
                {mode === "content" ? "Apply edit" : "Generate"}
              </Button>
            </div>
          </form>

          {history.length === 0 && !pending && (
            <div className="space-y-2 border-t border-bord pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-gry-d">
                Try refining this page
              </p>
              <p className="text-xs text-gry-d">
                Click an example to start, or write your own.
              </p>
              <ul className="space-y-1.5">
                {EXAMPLE_PROMPTS[mode].map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => setPrompt(example)}
                      className="block w-full rounded-md border border-bord bg-bg px-3 py-2 text-left text-xs text-gry transition-colors hover:border-teal/40 hover:bg-teal/10 hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                    >
                      &ldquo;{example}&rdquo;
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {history.length > 0 && (
            <div className="space-y-2 border-t border-bord pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-gry-d">
                Recent iterations
              </p>
              <ul className="space-y-2">
                {history.slice(0, 5).map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-start gap-2 text-xs text-gry"
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        entry.mode === "content"
                          ? "bg-elev text-gry"
                          : "bg-teal/10 text-teal",
                      )}
                    >
                      {entry.mode}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-gry">
                        &ldquo;{entry.prompt}&rdquo;
                      </span>
                      <span className="ml-2 text-gry-d">
                        · {entry.deploymentLabel}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
