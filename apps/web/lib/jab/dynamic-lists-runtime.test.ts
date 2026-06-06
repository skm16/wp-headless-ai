import { describe, it, expect } from "vitest";
import { parseAcfDate, selectListItems, normalizeRecord, resolveDynamicLists } from "./dynamic-lists-runtime";
import type { RBlock } from "./dynamic-lists-runtime";

describe("parseAcfDate", () => {
  it("parses 'Y-m-d H:i:s'", () => {
    expect(parseAcfDate("2026-06-06 18:00:00")).toBe(new Date("2026-06-06T18:00:00").getTime());
  });
  it("parses compact 'Ymd'", () => {
    expect(parseAcfDate("20260610")).toBe(new Date(2026, 5, 10).getTime());
  });
  it("returns null for junk/empty", () => {
    expect(parseAcfDate("")).toBeNull();
    expect(parseAcfDate("not a date")).toBeNull();
  });
});

describe("selectListItems", () => {
  const now = new Date("2026-06-04T12:00:00").getTime();
  const rec = (id: number, d: string) => ({ id, acf: { start_date__time: d }, date: "2020-01-01T00:00:00" });

  it("keeps only future events, sorts ascending, caps to limit", () => {
    const items = selectListItems(
      [rec(1, "2026-06-10 00:00:00"), rec(2, "2026-06-06 00:00:00"), rec(3, "2026-05-01 00:00:00")],
      { dateField: "start_date__time", order: "asc", upcomingOnly: true, limit: 2 }, now,
    );
    expect(items.map((r) => r.id)).toEqual([2, 1]);
  });

  it("with no date field and no resolvable dates, returns input order capped (stable fallback)", () => {
    const items = selectListItems(
      [{ id: 9, acf: {} }, { id: 8, acf: {} }, { id: 7, acf: {} }],
      { dateField: null, order: "desc", upcomingOnly: false, limit: 2 }, now,
    );
    expect(items.map((r) => r.id)).toEqual([9, 8]);
  });

  it("sorts a recent blog list by the published date descending (latest first), then caps", () => {
    // Records arrive in arbitrary order; the newest by top-level `date` must win.
    const items = selectListItems(
      [
        { id: 1, date: "2026-01-01T00:00:00", acf: {} },
        { id: 2, date: "2026-06-01T00:00:00", acf: {} },
        { id: 3, date: "2026-03-01T00:00:00", acf: {} },
      ],
      { dateField: null, order: "desc", upcomingOnly: false, limit: 2 }, now,
    );
    expect(items.map((r) => r.id)).toEqual([2, 3]);
  });
});

describe("normalizeRecord", () => {
  it("maps a CPT record to the JabListItem contract", async () => {
    const item = await normalizeRecord(
      { id: 5, title: "Trivia Night", link: "https://x.com/event/trivia", excerpt: "Fun",
        featured_image: { url: "https://x.com/a.jpg", alt: "a" }, acf: { start_date__time: "2026-06-10 18:00:00", ticket_link: "t" } },
      { dateField: "start_date__time" },
    );
    expect(item).toEqual({
      id: 5, title: "Trivia Night", url: "https://x.com/event/trivia", excerpt: "Fun",
      image: { url: "https://x.com/a.jpg", alt: "a" },
      date: "2026-06-10 18:00:00",
      acf: { start_date__time: "2026-06-10 18:00:00", ticket_link: "t" },
    });
  });

  // Blog posts have no ACF start-date, so dateField is null — but a news card
  // still needs a date. Fall back to the top-level WP published `date` so
  // "NEWS FROM THE ROAD" cards show when each post went live.
  it("falls back to the top-level published date when there is no ACF date field", async () => {
    const item = await normalizeRecord(
      {
        id: 7,
        title: { rendered: "On the Road Again" },
        link: "https://x.com/news/on-the-road",
        excerpt: { rendered: "<p>Tour recap</p>" },
        featured_image: { url: "https://x.com/n.jpg", alt: "n" },
        date: "2026-05-20T09:30:00",
      },
      { dateField: null },
    );
    expect(item.date).toBe("2026-05-20T09:30:00");
    expect(item.title).toBe("On the Road Again");
    expect(item.excerpt).toBe("Tour recap");
  });

  it("prefers the ACF date field over the published date when both exist", async () => {
    const item = await normalizeRecord(
      { id: 8, title: "Gala", link: "/event/gala", excerpt: "",
        date: "2020-01-01T00:00:00", acf: { start_date__time: "2026-06-10 18:00:00" } },
      { dateField: "start_date__time" },
    );
    expect(item.date).toBe("2026-06-10 18:00:00");
  });
});

describe("resolveDynamicLists", () => {
  const SPEC = {
    "acf_flex/page/page_builder/upcoming_events": {
      blockName: "acf_flex/page/page_builder/upcoming_events",
      listAbility: "jab/get-event", wrapperKey: "event", postType: "event",
      dateField: "start_date__time", order: "asc", upcomingOnly: true, limit: 3,
    },
  } as const;
  const now = new Date("2026-06-04T12:00:00").getTime();

  it("injects block.attrs.items from the list ability, filtered + normalized", async () => {
    const calls: Array<[string, unknown]> = [];
    const callAbility = async (name: string, input?: Record<string, unknown>) => {
      calls.push([name, input]);
      return { event: [
        { id: 1, title: "Past", link: "/event/past", excerpt: "", acf: { start_date__time: "2026-05-01 00:00:00" } },
        { id: 2, title: "Soon", link: "/event/soon", excerpt: "Soon!", acf: { start_date__time: "2026-06-06 00:00:00" } },
      ] };
    };
    const blocks: RBlock[] = [{ blockName: "acf_flex/page/page_builder/upcoming_events", attrs: { section_headline: "Upcoming Events" }, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, SPEC, undefined, now);

    expect(calls[0][0]).toBe("jab/get-event");
    // Only numberposts is sent — the list ability is additionalProperties:false.
    expect(calls[0][1]).toEqual({ numberposts: 100 });
    expect(blocks[0].attrs.section_headline).toBe("Upcoming Events"); // config preserved
    const items = blocks[0].attrs.items as Array<{ id: number }>;
    expect(items.map((i) => i.id)).toEqual([2]); // only the future event
  });

  it("sets items to [] (never throws) when the ability call fails — component renders its empty state", async () => {
    const callAbility = async () => { throw new Error("boom"); };
    const blocks: RBlock[] = [{ blockName: "acf_flex/page/page_builder/upcoming_events", attrs: {}, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, SPEC, undefined, now);
    expect(blocks[0].attrs.items).toEqual([]);
  });

  it("ignores blocks with no matching spec", async () => {
    const callAbility = async () => ({ event: [] });
    const blocks: RBlock[] = [{ blockName: "acf_flex/page/page_builder/newsletter", attrs: {}, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, SPEC, undefined, now);
    expect(blocks[0].attrs.items).toBeUndefined();
  });

  it("requests newest-first from the server for a recent blog list (orderby=date desc)", async () => {
    const calls: Array<[string, unknown]> = [];
    const callAbility = async (name: string, input?: Record<string, unknown>) => {
      calls.push([name, input]);
      return { posts: [
        { id: 1, title: "Old", link: "/news/old", excerpt: "", date: "2026-01-01T00:00:00" },
        { id: 2, title: "New", link: "/news/new", excerpt: "", date: "2026-06-01T00:00:00" },
      ] };
    };
    const blogSpec = {
      "acf_flex/page/page_builder/featured-news": {
        blockName: "acf_flex/page/page_builder/featured-news",
        listAbility: "jab/get-posts", wrapperKey: "posts", postType: "posts",
        dateField: null, order: "desc" as const, upcomingOnly: false, limit: 2,
      },
    };
    const blocks: RBlock[] = [{ blockName: "acf_flex/page/page_builder/featured-news", attrs: {}, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, blogSpec, undefined, now);
    // orderby/order are declared members of the list ability inputSchema enums,
    // so they're safe to send despite additionalProperties:false.
    expect(calls[0][1]).toEqual({ numberposts: 100, orderby: "date", order: "desc" });
    const items = blocks[0].attrs.items as Array<{ id: number }>;
    expect(items.map((i) => i.id)).toEqual([2, 1]); // newest first
  });
});
