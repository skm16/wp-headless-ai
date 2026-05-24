"use client";

import { OnboardingWizard } from "@/components/onboarding-wizard";
import { PreviewFrame } from "@/components/preview-frame";
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
  previewHtml: string | null;
}

/**
 * Client wrapper bridging the OnboardingWizard's typed callbacks to the
 * four server actions. Each action is RLS-scoped via the user's session;
 * the projectId is closed over from the route's server-side read so the
 * client can't substitute it.
 *
 * Why "throw to surface error" for saveIntent: the wizard's onSaveIntent
 * contract is "resolve = advance, reject = block + show error." Server
 * actions return `{ error?: string } | null`, so we manually translate
 * a non-null error into a thrown Error here.
 */
export function OnboardingWizardClient({
  projectId,
  wpUrl,
  initialIntent,
  initialStepIndex,
  initialContentTypes,
  initialOwnership,
  previewHtml,
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
        // completeOnboardingAction redirects on success — the Promise
        // never resolves on the happy path. On error it returns a
        // payload we surface to the wizard's finish-step Alert.
        const result = await completeOnboardingAction(projectId, ownership);
        if (result?.error) throw new Error(result.error);
      }}
      aside={
        previewHtml ? (
          <PreviewFrame
            srcDoc={previewHtml}
            url={wpUrl}
            status="idle"
            title="Your saved preview"
            caption="From /preview — the first real deploy will refresh it."
          />
        ) : undefined
      }
    />
  );
}
