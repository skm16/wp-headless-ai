"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ── Data ─────────────────────────────────────────────────────────────────────

type AgentStep = { t: string };

type ConversationItem =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "agent"; steps: AgentStep[]; note: string };

const CONV_HISTORY: ConversationItem[] = [
  {
    id: 1,
    role: "user",
    text: "Generate the homepage template from our WordPress content",
  },
  {
    id: 2,
    role: "agent",
    steps: [
      { t: "Connected to wordpress.tworoadsbrewing.com" },
      { t: "Loaded 47 items across 8 content types" },
      { t: "Identified: hero, beer catalog, events block" },
      { t: "Generated homepage.liquid + component partials" },
      { t: "Preview deployed → tworoadsbrewing.jabwp.app" },
    ],
    note: "Homepage generated with hero, beer grid, and events using your live WP content.",
  },
  {
    id: 3,
    role: "user",
    text: "Make the hero full-bleed with the brand navy overlay",
  },
  {
    id: 4,
    role: "agent",
    steps: [
      { t: "Read hero-section.liquid" },
      { t: "Updated layout → 100vw full-bleed, min-height: 100vh" },
      { t: "Applied navy overlay: #0a1932 at 72% opacity" },
      { t: "Preview updated → deploy #d-041" },
    ],
    note: "Done. Hero is now full-bleed with the navy overlay.",
  },
];

const ACTIVE_PROMPT = "Add a sticky nav that shows beer categories on scroll";

const ACTIVE_STEPS: AgentStep[] = [
  { t: "Analyzing nav.liquid template" },
  { t: "Fetching beer categories from WP (8 found)" },
  { t: "Writing sticky nav with category scroll behaviour" },
  { t: "Updating CSS transitions and z-index stacking" },
  { t: "Pushing to preview" },
];

type WPType = {
  type: string;
  count: number;
  icon: string;
  fields: string[];
  sample?: Record<string, string>;
};

const WP_TYPES: WPType[] = [
  {
    type: "posts",
    count: 23,
    icon: "📝",
    fields: ["title", "excerpt", "featured_image", "date", "categories"],
  },
  {
    type: "pages",
    count: 6,
    icon: "📄",
    fields: ["title", "content", "hero_image", "seo_title"],
  },
  {
    type: "beers",
    count: 12,
    icon: "🍺",
    fields: [
      "name",
      "style",
      "abv",
      "ibu",
      "description",
      "image",
      "seasonal",
    ],
    sample: {
      name: "Ol' Factory Pils",
      style: "Pilsner",
      abv: "5.2%",
      seasonal: "Year-round",
    },
  },
  {
    type: "events",
    count: 4,
    icon: "🎉",
    fields: ["title", "date", "location", "ticket_url"],
  },
  {
    type: "team",
    count: 8,
    icon: "👥",
    fields: ["name", "role", "bio", "photo"],
  },
];

const CODE_SAMPLE = `{%- comment -%}
  hero-section.liquid
  Generated + managed by JAB AI
{%- endcomment -%}

<section class="hero hero--full-bleed"
  style="background:{{ settings.hero_bg }}">

  {%- if hero_image -%}
  <div class="hero__bg">
    <img
      src="{{ hero_image | img_url: '1920x' }}"
      alt="{{ hero_image.alt }}"
      loading="eager">
    <div class="hero__overlay"
         style="opacity:0.72"></div>
  </div>
  {%- endif -%}

  <div class="hero__content container">
    <p class="eyebrow">
      {{ settings.hero_eyebrow }}
    </p>
    <h1>{{ page.hero_heading }}</h1>
    <p class="hero__sub">
      {{ page.hero_subhead }}
    </p>
    <a href="{{ settings.cta_url }}"
       class="btn btn--primary">
      {{- settings.cta_label -}}
    </a>
  </div>
</section>`;

// ── Icon nav ─────────────────────────────────────────────────────────────────

function IconNav() {
  type Item = { d: string; tip: string; href?: string; active?: boolean };
  const items: Item[] = [
    {
      d: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
      tip: "Dashboard",
    },
    { d: "circle", tip: "Sites", active: true },
    { d: "M13 2L3 14h9l-1 8 10-12h-9z", tip: "Deploys" },
    {
      d: "M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z",
      tip: "AI",
    },
  ];
  return (
    <nav className="z-50 flex w-12 shrink-0 flex-col items-center gap-1 border-r border-bord bg-bg px-0 pb-3 pt-2.5">
      <a
        href="#"
        className="mb-2.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-bord bg-elev no-underline"
      >
        <svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <text
            x="2"
            y="21"
            fontFamily="var(--font-display), sans-serif"
            fontWeight="800"
            fontSize="17"
            fill="rgb(0 201 167)"
          >
            J
          </text>
        </svg>
      </a>
      {items.map((ic, i) => (
        <a
          key={i}
          href={ic.href ?? "#"}
          title={ic.tip}
          className={[
            "flex h-[34px] w-[34px] items-center justify-center rounded-[7px] border no-underline transition-colors",
            ic.active
              ? "border-teal/15 bg-teal/[0.09] text-teal"
              : "border-transparent text-gry-d hover:text-gry",
          ].join(" ")}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {ic.d === "circle" ? (
              <>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2C8.5 7 8.5 17 12 22M12 2C15.5 7 15.5 17 12 22" />
                <path d="M2 12h20" />
              </>
            ) : (
              <path d={ic.d} />
            )}
          </svg>
        </a>
      ))}
      <div className="mt-auto">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-bord bg-gradient-to-br from-[#1a4080] to-[#0f2040] font-display text-[11px] font-bold text-teal">
          SK
        </div>
      </div>
    </nav>
  );
}

// ── Top bar ──────────────────────────────────────────────────────────────────

interface TopBarProps {
  isStreaming: boolean;
  codeOpen: boolean;
  setCodeOpen: (next: boolean | ((v: boolean) => boolean)) => void;
  wpOpen: boolean;
  setWpOpen: (next: boolean | ((v: boolean) => boolean)) => void;
  project?: WorkspaceProject;
}

function TopBar({
  isStreaming,
  codeOpen,
  setCodeOpen,
  wpOpen,
  setWpOpen,
  project,
}: TopBarProps) {
  const backHref = project ? `/projects/${project.id}` : "#";
  const backLabel = project?.name ?? "Two Roads Brewing";
  return (
    <div
      className="z-40 flex h-12 shrink-0 items-center gap-2.5 border-b border-bord px-4"
      style={{
        background: "rgba(10,22,40,.96)",
        backdropFilter: "blur(12px)",
      }}
    >
      <a
        href={backHref}
        className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-gry-d no-underline transition-colors hover:text-gry"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        {backLabel}
      </a>

      <div className="h-[18px] w-px shrink-0 bg-bord" />

      <div className="flex shrink-0 cursor-pointer items-center gap-[7px] rounded-md border border-bord bg-elev px-2.5 py-1 font-mono text-[11px]">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(0 201 167)"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
        <span className="text-wht">Homepage</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(58 80 112)"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      <div className="flex-1" />

      <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-bord bg-bg px-2.5 py-[5px] font-mono text-[11px] text-gry-d">
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(0 201 167)"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        {project?.displayDomain || "tworoadsbrewing.jabwp.app"}
      </div>

      <button
        type="button"
        onClick={() => setWpOpen((v) => !v)}
        className={[
          "flex items-center gap-1.5 rounded-md border border-bord px-2.5 py-[5px] font-mono text-[11px] transition-colors",
          wpOpen ? "bg-teal/[0.09] text-teal" : "bg-transparent text-gry",
        ].join(" ")}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2C8.5 7 8.5 17 12 22M12 2C15.5 7 15.5 17 12 22" />
          <path d="M2 12h20" />
        </svg>
        Content
      </button>

      <button
        type="button"
        onClick={() => setCodeOpen((v) => !v)}
        className={[
          "flex items-center gap-1.5 rounded-md border border-bord px-2.5 py-[5px] font-mono text-[11px] transition-colors",
          codeOpen ? "bg-teal/[0.09] text-teal" : "bg-transparent text-gry",
        ].join(" ")}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        Code
      </button>

      <div className="h-[18px] w-px shrink-0 bg-bord" />

      <div
        className={[
          "flex shrink-0 items-center gap-1.5 font-mono text-[11px]",
          isStreaming ? "text-amb" : "text-teal",
        ].join(" ")}
      >
        <span
          className={[
            "block h-1.5 w-1.5 rounded-full",
            isStreaming ? "bg-amb" : "bg-teal",
          ].join(" ")}
          style={
            isStreaming
              ? { animation: "jab-pulse 1.2s ease-in-out infinite" }
              : undefined
          }
        />
        {isStreaming ? "Updating…" : "Preview live"}
      </div>

      <button
        type="button"
        className="flex shrink-0 items-center gap-1.5 rounded-md border-none bg-teal px-4 py-1.5 font-body text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M13 2L3 14h9l-1 8 10-12h-9z" />
        </svg>
        Publish
      </button>
    </div>
  );
}

// ── Agent block ──────────────────────────────────────────────────────────────

interface AgentBlockProps {
  steps: AgentStep[];
  note?: string;
  streaming: boolean;
  activeIdx: number;
}

function AgentBlock({ steps, note, streaming, activeIdx }: AgentBlockProps) {
  const resolved = streaming
    ? steps.map((s, i) => ({
        ...s,
        status:
          i < activeIdx ? "done" : i === activeIdx ? "active" : "pending",
      }))
    : steps.map((s) => ({ ...s, status: "done" as const }));

  return (
    <div className="mb-3.5">
      <div
        className="overflow-hidden rounded-lg border bg-bg transition-[border-color,box-shadow] duration-300"
        style={{
          borderColor: streaming ? "rgba(0,201,167,.3)" : "rgb(26 49 88)",
        }}
      >
        {resolved.map((step, i) => (
          <div
            key={i}
            className="flex items-start gap-2.5 px-3 py-[7px] transition-opacity duration-300"
            style={{
              borderBottom:
                i < resolved.length - 1
                  ? "1px solid rgba(26,49,88,.4)"
                  : "none",
              opacity: step.status === "pending" ? 0.22 : 1,
            }}
          >
            <div className="mt-0.5 shrink-0">
              {step.status === "done" ? (
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgb(0 201 167)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : step.status === "active" ? (
                <span
                  className="block h-[10px] w-[10px] rounded-full border-[1.5px] border-amb"
                  style={{
                    borderTopColor: "transparent",
                    animation: "jab-spin .7s linear infinite",
                  }}
                />
              ) : (
                <span className="block h-2 w-2 rounded-full border border-bord" />
              )}
            </div>
            <span
              className={[
                "flex-1 font-body text-xs leading-[1.5]",
                step.status === "done"
                  ? "text-gry"
                  : step.status === "active"
                    ? "text-wht"
                    : "text-gry-d",
              ].join(" ")}
            >
              {step.t}
              {step.status === "active" && (
                <span className="ml-0.5 animate-blink text-teal">▌</span>
              )}
            </span>
          </div>
        ))}
      </div>
      {note && !streaming && (
        <p className="px-1 pt-[7px] font-body text-xs leading-[1.55] text-gry">
          {note}
        </p>
      )}
    </div>
  );
}

// ── AI panel ─────────────────────────────────────────────────────────────────

interface AIPanelProps {
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
}

function AIPanel({ isStreaming, setIsStreaming }: AIPanelProps) {
  const [input, setInput] = useState("");
  const [showActive, setShowActive] = useState(false);
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const startStream = useCallback(() => {
    setShowActive(true);
    setIsStreaming(true);
    setActiveStepIdx(0);
    let idx = 0;
    const tick = () => {
      idx++;
      setActiveStepIdx(idx);
      if (idx < ACTIVE_STEPS.length) {
        const id = setTimeout(tick, 780 + Math.random() * 480);
        timersRef.current.push(id);
      } else {
        const id = setTimeout(() => setIsStreaming(false), 700);
        timersRef.current.push(id);
      }
    };
    const kickoff = setTimeout(tick, 980);
    timersRef.current.push(kickoff);
  }, [setIsStreaming]);

  useEffect(() => {
    const t = setTimeout(startStream, 1600);
    timersRef.current.push(t);
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [startStream]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [showActive, activeStepIdx]);

  function handleSend() {
    if (!input.trim() || isStreaming) return;
    setInput("");
    startStream();
  }

  const chips = ["Sync WP content", "Lighthouse audit", "View templates"];

  return (
    <div className="flex w-[322px] shrink-0 flex-col overflow-hidden border-r border-bord bg-surf">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-bord px-3.5">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(0 201 167)"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z" />
        </svg>
        <span className="text-[13px] font-bold text-wht">
          AI Assistant
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className={[
              "block h-1.5 w-1.5 rounded-full",
              isStreaming ? "bg-amb" : "bg-teal",
            ].join(" ")}
            style={
              isStreaming
                ? { animation: "jab-pulse 1.2s ease-in-out infinite" }
                : undefined
            }
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3.5"
      >
        {CONV_HISTORY.map((item) =>
          item.role === "user" ? (
            <div
              key={item.id}
              className="mb-2.5 self-end rounded-lg border border-bord bg-elev px-[11px] py-2 font-body text-xs leading-[1.5] text-wht"
              style={{ maxWidth: "88%" }}
            >
              {item.text}
            </div>
          ) : (
            <AgentBlock
              key={item.id}
              steps={item.steps}
              note={item.note}
              streaming={false}
              activeIdx={0}
            />
          ),
        )}

        {showActive && (
          <>
            <div
              className="mb-2.5 self-end rounded-lg border border-bord bg-elev px-[11px] py-2 font-body text-xs leading-[1.5] text-wht"
              style={{ maxWidth: "88%" }}
            >
              {ACTIVE_PROMPT}
            </div>
            <AgentBlock
              steps={ACTIVE_STEPS}
              streaming={isStreaming}
              activeIdx={activeStepIdx}
            />
          </>
        )}
      </div>

      <div
        className="flex flex-wrap gap-[5px] px-3 py-[7px]"
        style={{ borderTop: "1px solid rgba(26,49,88,.4)" }}
      >
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setInput(c)}
            className="cursor-pointer rounded border border-bord bg-elev px-2 py-[3px] font-mono text-[10px] text-gry-d transition-colors hover:border-gry-d hover:text-gry"
          >
            {c}
          </button>
        ))}
      </div>

      <div className="border-t border-bord bg-surf px-3 py-2.5">
        <div className="overflow-hidden rounded-lg border-[1.5px] border-bord bg-elev transition-colors focus-within:border-teal/40">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={isStreaming}
            placeholder={
              isStreaming ? "Agent working…" : "Describe a change to your site…"
            }
            rows={3}
            className="w-full resize-none border-none bg-transparent px-[11px] pb-1 pt-2.5 font-body text-[13px] leading-[1.5] text-wht outline-none disabled:opacity-40"
          />
          <div className="flex items-center justify-between px-[9px] py-[5px]">
            <span className="font-mono text-[10px] text-gry-d">
              ⏎ send · ⇧⏎ newline
            </span>
            <button
              type="button"
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
              className={[
                "flex items-center gap-1 rounded border-none px-3 py-[5px] font-body text-xs font-semibold transition-all",
                input.trim() && !isStreaming
                  ? "cursor-pointer bg-teal text-bg"
                  : "cursor-default bg-elev text-gry-d",
              ].join(" ")}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z" />
              </svg>
              Run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Site mock (Two Roads Brewing preview) ────────────────────────────────────

function SiteMock() {
  const beers = [
    { name: "Ol' Factory Pils", style: "Pilsner", abv: "5.2%", c: "#c8a84b" },
    { name: "Two Juicy", style: "Hazy IPA", abv: "7.1%", c: "#e8843a" },
    { name: "Road 2 Ruin", style: "DIPA", abv: "8.0%", c: "#7a4fcf" },
    { name: "Hexagon", style: "Session Sour", abv: "4.8%", c: "#2eb87e" },
  ];
  const events = [
    {
      title: "Summer Release Party",
      date: "Jun 14",
      desc: "New seasonal drops from the brewing team.",
    },
    {
      title: "Taproom Trivia Night",
      date: "Jun 21",
      desc: "Weekly trivia with prizes.",
    },
    {
      title: "Brewery Tour",
      date: "Jun 28",
      desc: "Behind-the-scenes at Stratford.",
    },
  ];
  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        background: "#0d0d0d",
        fontFamily: "system-ui,sans-serif",
        fontSize: 14,
        color: "#fff",
      }}
    >
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9,
          background: "rgba(10,10,10,.96)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid #1e1e1e",
          height: 56,
          padding: "0 40px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontFamily: "Georgia,serif",
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: ".06em",
          }}
        >
          TWO ROADS
        </span>
        <div
          style={{
            display: "flex",
            gap: 24,
            fontSize: 11,
            color: "#666",
            letterSpacing: ".12em",
            textTransform: "uppercase",
          }}
        >
          {["Beers", "Our Story", "Events", "Find Us"].map((l) => (
            <span key={l} style={{ cursor: "pointer" }}>
              {l}
            </span>
          ))}
        </div>
        <button
          style={{
            background: "#c8a84b",
            color: "#000",
            padding: "7px 16px",
            borderRadius: 2,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            border: "none",
            cursor: "pointer",
          }}
        >
          Taproom
        </button>
      </nav>

      <div
        style={{
          minHeight: "72vh",
          position: "relative",
          background: "linear-gradient(135deg,#0a1932 0%,#0d2444 100%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 40px",
          overflow: "hidden",
          textAlign: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "radial-gradient(circle at 65% 40%, rgba(200,168,75,.07) 0%, transparent 55%)",
          }}
        />
        <p
          style={{
            fontSize: 9,
            color: "#c8a84b",
            letterSpacing: ".35em",
            textTransform: "uppercase",
            marginBottom: 18,
            fontFamily: "monospace",
          }}
        >
          Stratford, Connecticut · Est. 2012
        </p>
        <h1
          style={{
            fontSize: "clamp(32px,4vw,56px)",
            fontFamily: "Georgia,serif",
            lineHeight: 1.1,
            fontWeight: 400,
            marginBottom: 20,
            maxWidth: 580,
          }}
        >
          Brewed for the road
          <br />
          <em style={{ color: "#c8a84b" }}>less traveled.</em>
        </h1>
        <p
          style={{
            fontSize: 14,
            color: "rgba(255,255,255,.5)",
            marginBottom: 34,
            maxWidth: 420,
            lineHeight: 1.65,
          }}
        >
          Unorthodox ales and lagers crafted at our 65,000 sq ft Stratford
          facility.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            style={{
              background: "#c8a84b",
              color: "#000",
              padding: "12px 26px",
              borderRadius: 2,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              border: "none",
              cursor: "pointer",
            }}
          >
            Explore Beers
          </button>
          <button
            style={{
              background: "transparent",
              color: "#fff",
              padding: "12px 26px",
              borderRadius: 2,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              border: "1px solid rgba(255,255,255,.2)",
              cursor: "pointer",
            }}
          >
            Our Story
          </button>
        </div>
      </div>

      <div style={{ padding: "44px 40px", background: "#0d0d0d" }}>
        <p
          style={{
            fontSize: 9,
            color: "#c8a84b",
            letterSpacing: ".3em",
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Current lineup
        </p>
        <h2
          style={{
            fontFamily: "Georgia,serif",
            fontSize: 26,
            marginBottom: 26,
            fontWeight: 400,
          }}
        >
          Fresh from the tank.
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4,1fr)",
            gap: 12,
          }}
        >
          {beers.map((b) => (
            <div
              key={b.name}
              style={{
                background: "#141414",
                border: "1px solid #1e1e1e",
                borderRadius: 3,
                overflow: "hidden",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  height: 100,
                  background: `linear-gradient(135deg,#1a1a1a,${b.c}22)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    border: `2px solid ${b.c}44`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                  }}
                >
                  🍺
                </div>
              </div>
              <div style={{ padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                  {b.name}
                </div>
                <div style={{ fontSize: 11, color: "#555", marginBottom: 6 }}>
                  {b.style}
                </div>
                <div
                  style={{ fontFamily: "monospace", fontSize: 11, color: b.c }}
                >
                  {b.abv} ABV
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 40px 44px", borderTop: "1px solid #1a1a1a" }}>
        <div
          style={{
            paddingTop: 44,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginBottom: 20,
          }}
        >
          <div>
            <p
              style={{
                fontSize: 9,
                color: "#c8a84b",
                letterSpacing: ".3em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Taproom events
            </p>
            <h2
              style={{
                fontFamily: "Georgia,serif",
                fontSize: 26,
                fontWeight: 400,
              }}
            >
              What&apos;s on tap.
            </h2>
          </div>
          <span style={{ fontSize: 11, color: "#444", cursor: "pointer" }}>
            View all →
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,1fr)",
            gap: 10,
          }}
        >
          {events.map((ev) => (
            <div
              key={ev.title}
              style={{
                background: "#141414",
                border: "1px solid #1e1e1e",
                borderRadius: 3,
                padding: "16px",
              }}
            >
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 10,
                  color: "#c8a84b",
                  marginBottom: 6,
                  letterSpacing: ".1em",
                }}
              >
                {ev.date}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {ev.title}
              </div>
              <div style={{ fontSize: 11, color: "#444", lineHeight: 1.5 }}>
                {ev.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Code panel (bottom of preview) ───────────────────────────────────────────

function CodePanel() {
  const files = [
    "homepage.liquid",
    "hero-section.liquid",
    "nav.liquid",
    "beer-card.liquid",
  ];
  const [active, setActive] = useState("hero-section.liquid");
  return (
    <div className="flex h-[224px] shrink-0 border-t border-bord bg-bg">
      <div className="w-[150px] shrink-0 overflow-y-auto border-r border-bord py-2.5">
        <div className="px-3 pb-2 font-mono text-[9px] uppercase tracking-[0.15em] text-gry-d">
          Templates
        </div>
        {files.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setActive(f)}
            className={[
              "w-full cursor-pointer border-l-2 border-none px-3 py-1.5 text-left font-mono text-[11px] transition-colors",
              f === active
                ? "border-l-teal bg-teal/[0.09] text-teal"
                : "border-l-transparent bg-transparent text-gry-d",
            ].join(" ")}
            style={{
              borderLeftWidth: 2,
              borderLeftStyle: "solid",
              borderLeftColor: f === active ? "rgb(0 201 167)" : "transparent",
            }}
          >
            {f}
          </button>
        ))}
      </div>
      <pre className="m-0 flex-1 overflow-auto px-4 py-3 font-mono text-[11px] leading-[1.75] text-gry">
        {CODE_SAMPLE}
      </pre>
    </div>
  );
}

// ── WP panel (right slide-in) ────────────────────────────────────────────────

function WPPanel({ onClose }: { onClose: () => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    beers: true,
  });
  return (
    <div
      className="flex w-[256px] shrink-0 flex-col overflow-hidden border-l border-bord bg-surf"
      style={{ animation: "jabSlideLeft .2s ease-out" }}
    >
      <div className="flex h-10 shrink-0 items-center border-b border-bord px-3.5">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(0 201 167)"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="mr-[7px] shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2C8.5 7 8.5 17 12 22M12 2C15.5 7 15.5 17 12 22" />
          <path d="M2 12h20" />
        </svg>
        <span className="text-[13px] font-bold text-wht">
          WordPress
        </span>
        <span className="ml-2 rounded-full border border-teal/20 bg-teal/[0.09] px-[7px] py-px font-mono text-[10px] text-teal">
          ● live
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto cursor-pointer border-none bg-transparent p-1 text-gry-d"
          aria-label="Close content panel"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2.5">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-gry-d">
            Content types · 8
          </span>
          <span className="font-mono text-[10px] text-gry-d">Synced 2m ago</span>
        </div>
        {WP_TYPES.map((ct) => (
          <div
            key={ct.type}
            className="mb-1.5 overflow-hidden rounded-lg border border-bord bg-bg"
          >
            <button
              type="button"
              onClick={() =>
                setExpanded((e) => ({ ...e, [ct.type]: !e[ct.type] }))
              }
              className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-2.5 py-2"
            >
              <span className="text-[13px]">{ct.icon}</span>
              <span className="flex-1 text-left font-mono text-[11px] text-wht">
                {ct.type}
              </span>
              <span className="rounded border border-bord bg-elev px-[5px] py-px font-mono text-[10px] text-gry-d">
                {ct.count}
              </span>
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgb(58 80 112)"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path
                  d={
                    expanded[ct.type] ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"
                  }
                />
              </svg>
            </button>
            {expanded[ct.type] && (
              <div className="border-t border-bord p-2.5">
                <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gry-d">
                  Fields
                </div>
                <div
                  className="flex flex-wrap gap-[3px]"
                  style={{ marginBottom: ct.sample ? 10 : 0 }}
                >
                  {ct.fields.map((f) => (
                    <span
                      key={f}
                      className="rounded border border-bord bg-elev px-[5px] py-[2px] font-mono text-[10px] text-gry"
                    >
                      {f}
                    </span>
                  ))}
                </div>
                {ct.sample && (
                  <>
                    <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gry-d">
                      Sample record
                    </div>
                    {Object.entries(ct.sample).map(([k, v]) => (
                      <div key={k} className="mb-[3px] flex gap-2">
                        <span className="w-[62px] shrink-0 font-mono text-[10px] text-gry-d">
                          {k}
                        </span>
                        <span className="font-mono text-[10px] text-teal">
                          {v}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Preview pane ─────────────────────────────────────────────────────────────

/**
 * Shown in the workspace's preview slot when a real project is loaded but
 * `preview_html` is null (e.g. the user landed here right after onboarding
 * and the regenerate worker hasn't finished yet, or it failed). Points the
 * user back to the project page where the Regenerate button + status chip
 * live — we don't duplicate that control here.
 */
function NoPreviewFallback({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
      <p className="font-display text-sm font-bold text-wht">
        No homepage preview yet
      </p>
      <p className="font-mono text-[11px] text-gry-d">
        Generate one from the project page to see it here.
      </p>
      <a
        href={`/projects/${projectId}`}
        className="inline-flex h-7 items-center rounded-md border border-bord px-2.5 font-mono text-[11px] text-wht no-underline transition-colors hover:border-teal hover:text-teal"
      >
        Open project →
      </a>
    </div>
  );
}

interface PreviewPaneProps {
  isStreaming: boolean;
  codeOpen: boolean;
  project?: WorkspaceProject;
}

function PreviewPane({ isStreaming, codeOpen, project }: PreviewPaneProps) {
  const [mobile, setMobile] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-bord bg-surf px-3">
        <div className="flex gap-1">
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div
              key={c}
              className="h-2 w-2 rounded-full"
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="mx-auto flex max-w-[340px] flex-1 items-center gap-1.5 rounded-md border border-bord bg-elev px-2.5 py-1 font-mono text-[11px] text-gry">
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgb(0 201 167)"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="truncate">
            {project?.displayDomain || "tworoadsbrewing.jabwp.app"}
          </span>
        </div>
        <div className="ml-auto flex gap-[5px]">
          <div className="flex overflow-hidden rounded-md border border-bord bg-elev">
            <button
              type="button"
              onClick={() => setMobile(false)}
              title="desktop"
              className={[
                "flex h-[26px] w-7 items-center justify-center border-none bg-transparent",
                !mobile ? "text-teal" : "text-gry-d",
              ].join(" ")}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M20 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h7l-2 3h6l-2-3h7a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setMobile(true)}
              title="mobile"
              className={[
                "flex h-[26px] w-7 items-center justify-center border-none bg-transparent",
                mobile ? "text-teal" : "text-gry-d",
              ].join(" ")}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <rect x="7" y="2" width="10" height="20" rx="2" />
                <circle cx="12" cy="17" r="0.5" fill="currentColor" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            title="Open in tab"
            className="flex h-[26px] w-7 items-center justify-center rounded-md border border-bord bg-transparent text-gry-d"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div
          className="flex flex-1 overflow-hidden"
          style={{
            justifyContent: mobile ? "center" : "stretch",
            padding: mobile ? 20 : 0,
            background: mobile ? "rgb(6 13 22)" : "transparent",
          }}
        >
          <div
            className="relative shrink-0 overflow-hidden"
            style={{
              width: mobile ? 375 : "100%",
              height: "100%",
              border: mobile ? "8px solid rgb(15 32 64)" : "none",
              borderRadius: mobile ? 22 : 0,
              boxShadow: mobile ? "0 20px 60px rgba(0,0,0,.5)" : "none",
              transition: "box-shadow .4s",
            }}
          >
            {isStreaming && (
              <div
                className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border px-2.5 py-[5px] font-mono text-[11px] text-teal"
                style={{
                  background: "rgba(0,8,20,.9)",
                  borderColor: "rgba(0,201,167,.3)",
                }}
              >
                <span
                  className="block h-1.5 w-1.5 rounded-full bg-amb"
                  style={{
                    animation: "jab-pulse 1.2s ease-in-out infinite",
                  }}
                />
                Updating preview
              </div>
            )}
            {/* Three modes:
                  • no `project` prop → stakeholder demo route, render the
                    built-in Two Roads SiteMock as before.
                  • project + previewHtml → render the project's generated
                    homepage in a sandboxed iframe. Same posture as
                    HeroPreview (allow-scripts, no allow-same-origin) so
                    the embedded HTML can run its own JS but can't reach
                    the parent's cookies/DOM.
                  • project + no preview yet → honest empty state pointing
                    back to the project page where the regenerate button
                    lives. Better than a misleading fake site. */}
            {!project ? (
              <SiteMock />
            ) : project.previewHtml ? (
              <iframe
                srcDoc={project.previewHtml}
                title={`Homepage preview for ${project.displayDomain || project.name}`}
                sandbox="allow-scripts"
                className="block h-full w-full border-0 bg-bg"
              />
            ) : (
              <NoPreviewFallback projectId={project.id} />
            )}
          </div>
        </div>
        {codeOpen && <CodePanel />}
      </div>
    </div>
  );
}

// ── App shell ────────────────────────────────────────────────────────────────

/**
 * Real project data threaded into the workspace from the per-project route.
 * When omitted (the `/ui-kit/workspace-jab` stakeholder demo), the component
 * falls back to its built-in Two Roads mock everywhere this would be used.
 */
export interface WorkspaceProject {
  id: string;
  name: string;
  displayDomain: string;
  previewHtml: string | null;
}

export function WorkspaceJabDemo({
  project,
}: { project?: WorkspaceProject } = {}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [wpOpen, setWpOpen] = useState(false);

  return (
    <>
      <KeyframeStyles />
      <div className="flex h-screen overflow-hidden bg-bg">
        <IconNav />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            isStreaming={isStreaming}
            codeOpen={codeOpen}
            setCodeOpen={setCodeOpen}
            wpOpen={wpOpen}
            setWpOpen={setWpOpen}
            project={project}
          />
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <AIPanel isStreaming={isStreaming} setIsStreaming={setIsStreaming} />
            <PreviewPane
              isStreaming={isStreaming}
              codeOpen={codeOpen}
              project={project}
            />
            {wpOpen && <WPPanel onClose={() => setWpOpen(false)} />}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The pulse / spin / slide-in keyframes the prototype relies on. globals.css
 * already defines `blink`; the rest live here so the demo route is
 * self-contained and doesn't pollute the global stylesheet.
 */
function KeyframeStyles(): ReactNode {
  return (
    <style>{`
      @keyframes jab-spin { to { transform: rotate(360deg); } }
      @keyframes jab-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
      @keyframes jabSlideLeft {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    `}</style>
  );
}
