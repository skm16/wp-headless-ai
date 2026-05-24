import { cn } from "@/lib/utils";
import { InfoIcon } from "@/components/ui/icons";

export interface CaveatsBannerProps {
  /** Override the default title. */
  title?: string;
  /** Override the default bullet list of gaps. */
  items?: string[];
  /** Override the default footer copy. */
  footer?: string;
  /** Optional CTA rendered at the bottom (e.g. <Button>Connect WordPress</Button>). */
  action?: React.ReactNode;
  className?: string;
}

const DEFAULT_TITLE = "What we couldn't see from public HTML";

const DEFAULT_ITEMS = [
  "Custom fields and custom post types",
  "The full menu structure",
  "Posts and pages not linked from the homepage",
  "Members-only or logged-in content",
];

const DEFAULT_FOOTER =
  "These come in once you connect WordPress. We'll walk you through it after you save your preview.";

/**
 * Informational banner explaining the limits of the public-scrape generator.
 * Lives under PreviewFrame on /preview (§12 step 2) and re-appears in the
 * project workspace pre-plugin-connect. Tone is encouragement, not warning —
 * the gaps are "you ain't seen nothin' yet," not "your preview is broken."
 */
export function CaveatsBanner({
  title = DEFAULT_TITLE,
  items = DEFAULT_ITEMS,
  footer = DEFAULT_FOOTER,
  action,
  className,
}: CaveatsBannerProps) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-blue/30 bg-blue/10 px-5 py-4 text-blue",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <InfoIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue" />
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm font-semibold">{title}</p>
          <ul className="space-y-1.5 text-sm">
            {items.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <BulletDot />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          {footer && <p className="text-sm">{footer}</p>}
          {action && <div className="pt-1">{action}</div>}
        </div>
      </div>
    </div>
  );
}

function BulletDot() {
  return (
    <span
      aria-hidden="true"
      className="mt-2 h-1 w-1 shrink-0 rounded-full bg-blue/50"
    />
  );
}
