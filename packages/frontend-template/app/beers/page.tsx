import { skmClient } from "@/lib/skm/client";
import { getBeers } from "@/lib/sdk";

// Server Component — runs at build/request time on the Node.js side.
// Credentials never reach the browser.
export const revalidate = 60;

export default async function BeersPage() {
  const { beers } = await getBeers(skmClient);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Beers</h1>
        <p className="text-neutral-600">
          {beers.length} {beers.length === 1 ? "beer" : "beers"} from the WP backend.
        </p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {beers.map((beer) => (
          <li key={beer.id} className="rounded border border-neutral-200 bg-white p-4">
            <h2 className="text-lg font-medium">{beer.title}</h2>
            <BeerDetails beer={beer} />
            <a
              href={beer.link}
              className="mt-3 inline-block text-sm text-blue-600 hover:underline"
            >
              View on site →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Splits ACF rendering out so the example shows how the typed SDK feels.
 * `beer.acf` is fully typed — IDE autocompletes abv, ibu, etc.
 */
function BeerDetails({ beer }: { beer: Awaited<ReturnType<typeof getBeers>>["beers"][number] }) {
  const acf = beer.acf;
  if (!acf) return null;
  const stats: Array<[string, string | number | undefined]> = [
    ["ABV", acf.abv as string | undefined],
    ["IBU", acf.ibu as string | undefined],
    ["SRM", acf.srm as string | undefined],
  ];
  const visibleStats = stats.filter(([, v]) => v !== undefined && v !== "");

  // ACF wysiwyg returns HTML. We render plain-text only here to keep the
  // template safe-by-default. Agencies wanting rich rendering should swap in
  // DOMPurify (or similar) and use dangerouslySetInnerHTML on the sanitized
  // output. NEVER trust raw WP HTML — even authenticated authors can inject.
  const descriptionText =
    typeof acf.description === "string" ? stripHtml(acf.description).trim() : "";

  return (
    <div className="mt-2 space-y-2 text-sm text-neutral-600">
      {visibleStats.length > 0 && (
        <dl className="flex gap-4">
          {visibleStats.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
              <dd className="font-medium text-neutral-700">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {descriptionText.length > 0 && (
        <p className="line-clamp-3 text-sm text-neutral-600">{descriptionText}</p>
      )}
    </div>
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}
