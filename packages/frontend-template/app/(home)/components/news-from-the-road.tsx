import type { GetPostsOutput } from "@/lib/sdk";

type Post = GetPostsOutput["posts"][number];

/**
 * "News From The Road" — recent posts in a horizontal image-left/text-right
 * layout, two visible at a time. The current SDK schema doesn't surface a
 * post thumbnail, so each card uses a deterministic gradient placeholder
 * with the post's first letters as a visual hook.
 */
export function NewsFromTheRoad({ posts }: { posts: Post[] }) {
  if (posts.length === 0) return null;
  const visible = posts.slice(0, 2);

  return (
    <section className="bg-[#fdf7e6] pb-16">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-center text-2xl font-bold uppercase tracking-[0.18em] text-[#0c2542] sm:text-3xl">
          News From The Road
        </h2>
        <ul className="mt-12 space-y-6">
          {visible.map((post) => (
            <NewsRow key={post.id} post={post} />
          ))}
        </ul>
        <div className="mt-12 text-center">
          <a
            href="/news"
            className="inline-block text-sm font-bold uppercase tracking-[0.18em] text-[#0c2542] transition hover:text-[#0c2542]/70"
          >
            See All News <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function NewsRow({ post }: { post: Post }) {
  const visual = visualForPost(post);
  return (
    <article className="grid overflow-hidden rounded-md bg-white shadow-sm md:grid-cols-[300px_1fr]">
      <div
        className="flex h-48 items-center justify-center md:h-auto"
        style={{ background: visual.background }}
      >
        <span className="text-3xl font-black uppercase tracking-tight text-white/95 drop-shadow-lg">
          {visual.label}
        </span>
      </div>
      <div className="p-6 md:p-8">
        <h3 className="text-xl font-bold leading-snug text-[#0c2542]">{post.title}</h3>
        {post.excerpt && (
          <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-neutral-600">{post.excerpt}</p>
        )}
        <a
          href={post.link}
          className="mt-4 inline-block text-xs font-bold uppercase tracking-[0.18em] text-[#fcc500] hover:text-[#0c2542]"
        >
          Learn More <span aria-hidden>›</span>
        </a>
      </div>
    </article>
  );
}

function visualForPost(post: Post): { background: string; label: string } {
  const palettes = [
    "linear-gradient(135deg, #fcc500 0%, #ce8b1a 100%)",
    "linear-gradient(135deg, #0c2542 0%, #1f4673 100%)",
    "linear-gradient(135deg, #5b1d6a 0%, #d61680 100%)",
  ];
  const idx = (post.id || post.title.length) % palettes.length;
  const words = post.title.split(/\s+/).filter(Boolean);
  const label = words.slice(0, 2).join(" ").toUpperCase();
  return { background: palettes[idx]!, label: label.length > 0 ? label : "TWO ROADS" };
}
