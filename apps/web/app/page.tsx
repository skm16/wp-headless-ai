import Link from "next/link";

// Marketing landing — placeholder for Phase B. Real positioning + screenshots
// land once we have a working demo to point at.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 px-6 py-20 text-center">
      <h1 className="text-5xl font-extrabold tracking-tight">
        WordPress is just a blog. <span className="text-rose-600">So we built Jab.</span>
      </h1>
      <p className="max-w-xl text-lg text-slate-600">
        Generate a typed Next.js project from any WordPress site, page by page,
        with AI assistance. Your code, your GitHub, your deploy.
      </p>
      <Link
        href="/sign-in"
        className="rounded-md bg-slate-900 px-6 py-3 text-base font-medium text-white hover:bg-slate-700"
      >
        Get started
      </Link>
    </main>
  );
}
