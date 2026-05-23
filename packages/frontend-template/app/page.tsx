import { getBeers, getEvents, getLocations, getPosts } from "@/lib/sdk";
import { skmClient } from "@/lib/skm/client";
import { HeroBlock, pickHeroBeer } from "./(home)/components/hero-block";
import { QuickActions } from "./(home)/components/quick-actions";
import { FeaturedOfferings } from "./(home)/components/featured-offerings";
import { UpcomingEvents } from "./(home)/components/upcoming-events";
import { NewsFromTheRoad } from "./(home)/components/news-from-the-road";
import { VisitUs } from "./(home)/components/visit-us";
import { NewsletterStrip, FindNearYouStrip } from "./(home)/components/bottom-strips";

// Revalidate every 5 minutes — events and beers shift, but not minute-to-minute.
export const revalidate = 300;

export default async function Home() {
  // Fan out four typed SDK calls in parallel. Promise.allSettled keeps the
  // homepage robust to per-ability failures: one bad upstream becomes one
  // missing section, not a dead page.
  const [beersR, eventsR, postsR, locationsR] = await Promise.allSettled([
    getBeers(skmClient, { numberposts: 50 }),
    getEvents(skmClient, { numberposts: 25 }),
    getPosts(skmClient, { numberposts: 4 }),
    getLocations(skmClient, { numberposts: 10 }),
  ]);

  logRejection("beers", beersR);
  logRejection("events", eventsR);
  logRejection("posts", postsR);
  logRejection("locations", locationsR);

  const beers = beersR.status === "fulfilled" ? beersR.value.beers : [];
  const events = eventsR.status === "fulfilled" ? eventsR.value.events : [];
  const posts = postsR.status === "fulfilled" ? postsR.value.posts : [];
  const locations = locationsR.status === "fulfilled" ? locationsR.value.locations : [];

  return (
    <>
      <HeroBlock heroBeer={pickHeroBeer(beers)} />
      <QuickActions />
      <FeaturedOfferings beers={beers} />
      <UpcomingEvents events={events} />
      <NewsFromTheRoad posts={posts} />
      <VisitUs locations={locations} />
      <NewsletterStrip />
      <FindNearYouStrip />
    </>
  );
}

function logRejection(label: string, result: PromiseSettledResult<unknown>): void {
  if (result.status === "rejected") {
    console.error(`[/] ${label} ability failed:`, result.reason);
  }
}
