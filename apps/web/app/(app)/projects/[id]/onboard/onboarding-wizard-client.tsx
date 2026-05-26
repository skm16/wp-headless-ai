"use client";

import { OnboardingWizard } from "@/components/onboarding-wizard";
import type {
  OwnershipMode,
  WPContentType,
} from "@/components/ownership-picker";
import type { ProjectIntent } from "@/components/intent-picker";
import {
  completeOnboardingAction,
  connectWpAction,
  saveIntentAction,
  verifyPluginAction,
} from "@/lib/actions/onboarding";

export interface OnboardingWizardClientProps {
  projectId: string;
  wpUrl: string;
  initialIntent: ProjectIntent;
  initialStepIndex: 0 | 1 | 2 | 3;
  initialContentTypes?: WPContentType[];
  initialOwnership?: Record<string, OwnershipMode>;
}

/**
 * Client wrapper bridging the OnboardingWizard's typed callbacks to the
 * four server actions. Each action is RLS-scoped via the user's session;
 * the projectId is closed over from the route's server-side read so the
 * client can't substitute it.
 *
 * Stage 0 v2: no `previewHtml` aside — the preview path is gone. The new
 * wow moment is the "we found N content types" surface inside the wizard's
 * Ownership step (rendered by OnboardingWizard, not here).
 */
export function OnboardingWizardClient({
  projectId,
  wpUrl,
  initialIntent,
  initialStepIndex,
  initialContentTypes,
  initialOwnership,
}: OnboardingWizardClientProps) {
  return (
    <OnboardingWizard
      wpUrl={wpUrl}
      initialIntent={initialIntent}
      initialStepIndex={initialStepIndex}
      initialContentTypes={initialContentTypes}
      initialOwnership={initialOwnership}
      onSaveIntent={async (intent) => {
        const result = await saveIntentAction(projectId, intent);
        if (result?.error) throw new Error(result.error);
      }}
      onConnect={async (creds) => {
        const result = await connectWpAction(projectId, creds);
        if (result.ok) return { ok: true, contentTypes: result.contentTypes };
        return { ok: false, error: result.error };
      }}
      onVerifyPlugin={() => verifyPluginAction(projectId)}
      onComplete={async ({ ownership }) => {
        const result = await completeOnboardingAction(projectId, ownership);
        if (result?.error) throw new Error(result.error);
      }}
    />
  );
}
