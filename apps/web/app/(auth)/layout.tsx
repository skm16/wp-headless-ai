/**
 * (auth) route-group layout — wraps sign-in and any future auth-related
 * public pages (forgot-password, magic-link verify, etc.) with a centered
 * card on a marketing-toned background. Distinct from (app)/layout.tsx
 * which carries the signed-in chrome (sidebar, user menu).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
            Jab
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            WordPress is just a blog. So we built Jab.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
