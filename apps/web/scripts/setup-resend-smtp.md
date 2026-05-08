# Wiring Resend to Supabase Auth (SMTP)

This is a **one-time manual config step** — Supabase doesn't expose an API for
SMTP settings, so it has to be done via the dashboard.

## Why

Without custom SMTP, Supabase Auth uses its own internal email service which
is rate-limited (~3 emails/hour on the free tier) and not great for production
deliverability. Routing through Resend gives:

- Higher rate limits + reliable delivery
- A unified sender domain (your verified Resend domain, not Supabase's)
- One place to view email logs (Resend dashboard) for both Supabase auth
  emails and our app's transactional sends
- A path forward for templating + analytics

## Prerequisites

- A Resend account at [resend.com](https://resend.com)
- A Resend API key (Dashboard → API Keys → Create). Save it as `re_...`.
- (Optional, for production) A verified domain in Resend
  (Dashboard → Domains → Add → DNS records). Until verified, Resend can only
  send to your own account email.

## Configure Supabase

Supabase Dashboard → your project → **Settings → Auth → SMTP Settings**:

| Field | Value |
|---|---|
| Enable Custom SMTP | ON |
| Sender email | `onboarding@resend.dev` (dev) or `noreply@yourdomain.com` (after domain verify) |
| Sender name | `Jab` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | your `re_...` API key |
| Minimum interval between emails | leave default |

Click **Save**. Supabase sends a test email — check your Resend dashboard
under "Emails" to confirm it arrived.

## Optional: enable email confirmation

Same page, Auth Providers → **Email**:

- **Confirm email**: ON (production), OFF (dev convenience)

When ON, sign-up creates the user in `auth.users` but blocks login until they
click a confirm link. Our `/auth/callback` route already handles the
post-confirm redirect.

For dev, leaving it OFF lets you sign up + log in immediately without checking
your inbox. For prod, flip it ON.

## Verify

After saving SMTP config:

1. Go to your app's `/sign-in`, sign up a fresh account.
2. Resend Dashboard → Emails — confirm a delivery (signup confirm OR auth
   webhook test) showed up.
3. If "Confirm email" is ON, the email should land in your Resend-account
   inbox (dev) or the recipient's inbox (with verified domain).

## Troubleshooting

- **"Failed to send confirmation email"** in the Supabase auth flow — check
  Resend dashboard for the failed send. Common cause: domain not verified
  yet AND recipient ≠ Resend account email.
- **No email arrives** — check spam, then Resend's "Emails" log to see if
  it sent at all. If not sent, SMTP creds are wrong; double-check username
  is literally `resend` (not your account email).
