import { getBeers, getEvents, getFoodTruckEvents, getLocations } from "@/lib/sdk";
import { skmClient } from "@/lib/skm/client";
import { pickFeaturedEvent } from "@/lib/this-week/featured-event";
import { buildWeekSchedule, startOfToday } from "@/lib/this-week/food-truck-schedule";
import { FeaturedEventHero } from "./components/featured-event-hero";
import { FoodTruckWeek } from "./components/food-truck-week";
import { LocationsTodayPanel } from "./components/locations-today-panel";
import { NewBeersRail } from "./components/new-beers-rail";
import { TileError } from "./components/tile-error";

// Revalidate every 5 minutes — events and food trucks shift, but not by the second.
export const revalidate = 300;

export default async function ThisWeekPage() {
  // Fan out four typed SDK calls in parallel. Use Promise.allSettled so a
  // single upstream failure (e.g. a broken WP-side schema for one ability)
  // degrades to a single broken tile instead of a full-page error.
  const [eventsResult, trucksResult, locationsResult, beersResult] = await Promise.allSettled([
    getEvents(skmClient, { numberposts: 25 }),
    getFoodTruckEvents(skmClient, { numberposts: 50 }),
    getLocations(skmClient, { numberposts: 10 }),
    getBeers(skmClient, { numberposts: 6 }),
  ]);

  logRejection("events", eventsResult);
  logRejection("food-truck events", trucksResult);
  logRejection("locations", locationsResult);
  logRejection("beers", beersResult);

  const week =
    trucksResult.status === "fulfilled"
      ? buildWeekSchedule(trucksResult.value.food_truck_events, startOfToday())
      : null;

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-6 py-12">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {weekLabel(startOfToday())}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">This week at Two Roads</h1>
        <p className="max-w-2xl text-neutral-600">
          One page composing four typed SDK abilities — events, food trucks, locations, and beers —
          on the server. No client-side data fetching, no untyped REST calls.
        </p>
      </header>

      {eventsResult.status === "fulfilled" ? (
        <FeaturedEventHero event={pickFeaturedEvent(eventsResult.value.events)} />
      ) : (
        <TileError label="featured event" reason={eventsResult.reason} />
      )}

      {week ? (
        <FoodTruckWeek week={week} />
      ) : (
        <TileError
          label="food truck schedule"
          reason={trucksResult.status === "rejected" ? trucksResult.reason : "unknown error"}
        />
      )}

      {locationsResult.status === "fulfilled" ? (
        <LocationsTodayPanel locations={locationsResult.value.locations} />
      ) : (
        <TileError label="tap rooms" reason={locationsResult.reason} />
      )}

      {beersResult.status === "fulfilled" ? (
        <NewBeersRail beers={beersResult.value.beers} />
      ) : (
        <TileError label="fresh beers" reason={beersResult.reason} />
      )}
    </div>
  );
}

function logRejection(label: string, result: PromiseSettledResult<unknown>): void {
  if (result.status === "rejected") {
    console.error(`[/this-week] ${label} ability failed:`, result.reason);
  }
}

function weekLabel(start: Date): string {
  const fmt = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric" });
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return `Week of ${fmt(start)} – ${fmt(end)}`;
}
