"use client";

import { useState } from "react";
import {
  IterationPanel,
  type IterationHistoryEntry,
  type IterationMode,
} from "@/components/iteration-panel";

/**
 * Kitchen-sink demo for the WP-managed IterationPanel state. The workspace
 * demo at /ui-kit/workspace shows the Jab-managed flow in context; this
 * isolated demo surfaces the disabled-content-edit case (the Content edit
 * toggle is disabled with explanatory copy when the page is WP-managed).
 */
export function IterationPanelWPDemo() {
  const [history, setHistory] = useState<IterationHistoryEntry[]>([]);

  function handleSubmit(prompt: string, mode: IterationMode) {
    setHistory((prev) => [
      {
        id: `iter_${Date.now()}`,
        prompt,
        mode,
        deploymentLabel: "preview · just now",
        createdAt: new Date(),
      },
      ...prev,
    ]);
  }

  return (
    <IterationPanel
      ownership="wp-managed"
      generationsLeft={3}
      history={history}
      onSubmit={handleSubmit}
    />
  );
}
