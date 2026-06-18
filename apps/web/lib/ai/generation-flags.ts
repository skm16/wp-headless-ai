// PURE module (deliberately NOT "server-only"): generation feature-flag
// readers. component-generator.ts and shell-prompts.ts/generate-shell.ts are
// also non-server-only (importable under tsx for operator scripts), so this
// must be too. Mirrors lib/ai/vision-prompt.ts's isVisionScoringEnabled.

/**
 * Default-off flag for multi-viewport (mobile, 375px) generation evidence.
 * When on, component prompts gain a mobile-reflow computed-style section and
 * shell prompts gain a responsive instruction. Exact "1" only.
 */
export function isResponsiveGenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAB_RESPONSIVE_GEN === "1";
}
