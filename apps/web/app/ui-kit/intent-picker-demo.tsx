"use client";

import { useState } from "react";
import {
  IntentChip,
  IntentPicker,
  type ProjectIntent,
} from "@/components/intent-picker";

/**
 * Kitchen-sink demo for IntentPicker + IntentChip. Holds the selection state
 * client-side and renders both components so reviewers can see how a change
 * in one propagates to the other.
 */
export function IntentPickerDemo() {
  const [intent, setIntent] = useState<ProjectIntent>("refresh");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        <span>As a workspace chip:</span>
        <IntentChip
          value={intent}
          onEdit={() => alert(`Open intent editor (current: ${intent})`)}
        />
      </div>
      <IntentPicker value={intent} onChange={setIntent} />
    </div>
  );
}
