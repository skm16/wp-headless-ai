"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DesignTokensReview,
  type DesignTokensPayload,
  type PersonalityPayload,
} from "@/components/design-tokens-review";

/**
 * Demo for the DesignTokensReview component — exercises every confidence
 * tier so we can see the high / review / refuse styling without needing a
 * real Stage 2 extraction.
 *
 * Three scenarios:
 *   1. High confidence across the board — the optimistic happy path.
 *   2. Mixed — some review-tier (0.4-0.7), some refuse-tier (<0.4).
 *   3. Pending — both columns null, surfaces the "studying" placeholder.
 */

type Scenario = "high" | "mixed" | "pending";

export function DesignTokensDemo() {
  const [scenario, setScenario] = useState<Scenario>("high");
  const { tokens, personality } = SCENARIOS[scenario];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <ScenarioButton
          active={scenario === "high"}
          onClick={() => setScenario("high")}
        >
          High confidence
        </ScenarioButton>
        <ScenarioButton
          active={scenario === "mixed"}
          onClick={() => setScenario("mixed")}
        >
          Mixed (review + refuse)
        </ScenarioButton>
        <ScenarioButton
          active={scenario === "pending"}
          onClick={() => setScenario("pending")}
        >
          Pending (extraction running)
        </ScenarioButton>
      </div>
      <DesignTokensReview tokens={tokens} personality={personality} />
    </div>
  );
}

function ScenarioButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "primary" : "ghost"}
      size="sm"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

const HIGH_TOKENS: DesignTokensPayload = {
  colors: {
    primary: {
      value: "#1d4ed8",
      confidence: 0.94,
      reasoning:
        "Appears on 4 buttons + the nav background. Used as text-on-white in the hero headline.",
    },
    secondary: {
      value: "#f59e0b",
      confidence: 0.88,
      reasoning:
        "Used as the accent color on the secondary CTA + the underline of the footer headings.",
    },
    accent: {
      value: "#e0e7ff",
      confidence: 0.81,
      reasoning:
        "Light tint of the primary, used as the card background on the features section.",
    },
  },
  typography: {
    heading: {
      value: "Inter",
      confidence: 0.92,
      reasoning:
        "Set on h1/h2 via Google Fonts include; weight 700 on the hero, 600 on section heads.",
    },
    body: {
      value: "Inter",
      confidence: 0.9,
      reasoning:
        "Same family as the heading, weight 400. The whole site is single-family Inter.",
    },
  },
  logo: {
    src: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Wikipedia_Logo_1.0.png/240px-Wikipedia_Logo_1.0.png",
    confidence: 0.93,
    reasoning:
      "Image [0] sits in <header>, has alt='Acme logo', and links to '/'. It's the largest image in that region.",
  },
  buttonPair: {
    primary: {
      value: "Get started",
      confidence: 0.9,
      reasoning:
        "Appears in the hero with the primary color background; matched the 'high contrast filled' visual pattern.",
    },
    secondary: {
      value: "Learn more",
      confidence: 0.85,
      reasoning:
        "Outline-style anchor in the hero, links to /about. Lower visual weight than 'Get started'.",
    },
  },
};

const HIGH_PERSONALITY: PersonalityPayload = {
  tone: {
    value: "professional, warm",
    confidence: 0.86,
    reasoning:
      "Hero copy uses first-person ('we help…') with concrete client outcomes. Footer is plain-spoken.",
  },
  energy: {
    value: "medium",
    confidence: 0.82,
    reasoning:
      "Balanced layout, no animation cues in the source HTML, moderate type scale.",
  },
  audience: {
    value: "established small businesses",
    confidence: 0.78,
    reasoning:
      "Headings reference 'your business' and 'growth'; testimonials section mentions owner names + cities.",
  },
};

const MIXED_TOKENS: DesignTokensPayload = {
  colors: {
    primary: {
      value: "#0f766e",
      confidence: 0.82,
      reasoning:
        "Used on the nav link hover + the primary CTA. Strong signal.",
    },
    secondary: {
      value: "#ec4899",
      confidence: 0.58,
      reasoning:
        "Only appears in one promo strip — could be a one-off accent rather than a brand color.",
    },
    accent: {
      value: null,
      confidence: 0.3,
      reasoning:
        "No third color found in the palette samples that wasn't a near-grey neutral.",
    },
  },
  typography: {
    heading: {
      value: "Playfair Display",
      confidence: 0.87,
      reasoning: "Serif heading, distinct from the body sans-serif.",
    },
    body: {
      value: "Source Sans Pro",
      confidence: 0.6,
      reasoning:
        "Body copy is set to the system font stack; Source Sans is the first preference but the others (Helvetica, Arial) would also load.",
    },
  },
  logo: {
    src: null,
    confidence: 0.25,
    reasoning:
      "No image in <header> with alt text; the site uses a text wordmark instead. Inferred from the site title.",
  },
  buttonPair: {
    primary: {
      value: "Book a consultation",
      confidence: 0.83,
      reasoning: "Repeated in the hero + the footer. High visual weight.",
    },
    secondary: {
      value: null,
      confidence: 0.0,
      reasoning:
        "No second clearly-recurring CTA copy. Site mostly uses links inline in body text.",
    },
  },
};

const MIXED_PERSONALITY: PersonalityPayload = {
  tone: {
    value: "expert, formal",
    confidence: 0.72,
    reasoning:
      "Industry vocabulary in the hero ('compliance', 'audit-ready'); no exclamation points anywhere.",
  },
  energy: {
    value: "low",
    confidence: 0.65,
    reasoning:
      "Conservative layout, lots of whitespace, no visual flourishes in the source markup.",
  },
  audience: {
    value: "regulated-industry professionals",
    confidence: 0.55,
    reasoning:
      "Mention of 'compliance' is the strongest signal, but the rest of the copy is generic 'help your business' language.",
  },
};
const SCENARIOS: Record<
  Scenario,
  {
    tokens: DesignTokensPayload | null;
    personality: PersonalityPayload | null;
  }
> = {
  high: { tokens: HIGH_TOKENS, personality: HIGH_PERSONALITY },
  mixed: { tokens: MIXED_TOKENS, personality: MIXED_PERSONALITY },
  pending: { tokens: null, personality: null },
};
