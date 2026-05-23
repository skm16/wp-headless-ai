"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Client-side sign-out — calls Supabase to clear cookies, then router.refresh
 * so the middleware re-evaluates auth state on the next request and redirects
 * to /sign-in for any (app)/* page.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={pending}
      loadingText="Signing out…"
      onClick={async () => {
        setPending(true);
        const supabase = createClient();
        await supabase.auth.signOut();
        router.replace("/");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
