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

  it("with no date field, returns input order capped (recent-list fallback)", () => {
    const items = selectListItems(
      [{ id: 9, acf: {} }, { id: 8, acf: {} }, { id: 7, acf: {} }],
      { dateField: null, order: "desc", upcomingOnly: false, limit: 2 }, now,
    );
    expect(items.map((r) => r.id)).toEqual([9, 8]);
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
});
