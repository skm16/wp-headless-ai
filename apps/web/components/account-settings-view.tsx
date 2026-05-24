"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Modal, ModalFooter } from "@/components/ui/modal";

export interface AccountProfile {
  fullName: string;
  email: string;
  /** Optional org/agency display name — distinct from `fullName`. */
  organizationName?: string;
}

export interface AccountSettingsViewProps {
  profile: AccountProfile;
  /** Persist profile changes. Parent owns the server call. */
  onSaveProfile: (next: AccountProfile) => void | Promise<void>;
  savingProfile?: boolean;
  /** Change password — Supabase auth call. Parent does the server work. */
  onChangePassword: (currentPassword: string, newPassword: string) => void | Promise<void>;
  changingPassword?: boolean;
  /** True if a password change just succeeded — surfaces the inline alert. */
  passwordChanged?: boolean;
  /** Error from the most recent password attempt. */
  passwordError?: string;
  /** Irreversible delete. Parent fires Supabase auth delete + cleanup. */
  onDeleteAccount: () => void | Promise<void>;
  deletingAccount?: boolean;
  /** Error from the most recent delete attempt — surfaces inside the modal. */
  deleteAccountError?: string;
}

/**
 * §6 IA — account-level `/settings` surface (name, email, password, danger
 * zone). Sectioned cards in a single column; tabs intentionally not
 * introduced yet — agencies have ~4 sections to navigate and that's not
 * enough surface area to need vertical chrome.
 *
 * Profile field changes are dirty-tracked locally and only sent on Save —
 * cheaper than autosave for fields that don't need realtime feedback.
 * Password is its own form; clears on success.
 * Delete account is double-gated by a modal that requires typing the email.
 */
export function AccountSettingsView({
  profile,
  onSaveProfile,
  savingProfile = false,
  onChangePassword,
  changingPassword = false,
  passwordChanged = false,
  passwordError,
  onDeleteAccount,
  deletingAccount = false,
  deleteAccountError,
}: AccountSettingsViewProps) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-wht">Account settings</h1>
        <p className="mt-1 text-sm text-gry">
          Your profile, sign-in credentials, and account-level actions.
        </p>
      </header>

      <ProfileCard
        profile={profile}
        onSave={onSaveProfile}
        saving={savingProfile}
      />

      <PasswordCard
        onChange={onChangePassword}
        changing={changingPassword}
        changed={passwordChanged}
        error={passwordError}
      />

      <DangerZoneCard
        email={profile.email}
        onDelete={onDeleteAccount}
        deleting={deletingAccount}
        error={deleteAccountError}
      />
    </div>
  );
}

function ProfileCard({
  profile,
  onSave,
  saving,
}: {
  profile: AccountProfile;
  onSave: (next: AccountProfile) => void | Promise<void>;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(profile);
  const dirty =
    draft.fullName !== profile.fullName ||
    draft.email !== profile.email ||
    (draft.organizationName ?? "") !== (profile.organizationName ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    onSave(draft);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <p className="mt-1 text-xs text-gry-d">
          Name and email used across sign-in and invoices.
        </p>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            label="Full name"
            value={draft.fullName}
            onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
            required
            autoComplete="name"
          />
          <Field
            label="Email"
            type="email"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            required
            autoComplete="email"
            hint="Changing this requires verifying the new address."
          />
          <Field
            label="Agency / organization (optional)"
            value={draft.organizationName ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, organizationName: e.target.value })
            }
            placeholder="Label Interactive"
            autoComplete="organization"
          />
          <div className="flex items-center justify-end gap-2 border-t border-bord pt-4">
            {dirty && !saving && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(profile)}
                type="button"
              >
                Discard
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              loading={saving}
              loadingText="Saving…"
              disabled={!dirty}
            >
              Save changes
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function PasswordCard({
  onChange,
  changing,
  changed,
  error,
}: {
  onChange: (currentPassword: string, newPassword: string) => void | Promise<void>;
  changing: boolean;
  changed: boolean;
  error?: string;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = next && confirm && next !== confirm;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !next || mismatch || changing) return;
    onChange(current, next);
    // Don't clear in this handler — wait for `changed` (the parent's success
    // signal) so a server-side rejection doesn't wipe the user's input.
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <p className="mt-1 text-xs text-gry-d">
          Use at least 8 characters. Sign-in sessions on other devices stay
          active.
        </p>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          {changed && (
            <Alert tone="success">Password updated.</Alert>
          )}
          {error && <Alert tone="danger">{error}</Alert>}

          <Field
            label="Current password"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
          <Field
            label="New password"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            required
          />
          <Field
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            error={mismatch ? "Passwords don't match." : undefined}
            required
          />
          <div className="flex items-center justify-end border-t border-bord pt-4">
            <Button
              type="submit"
              size="sm"
              loading={changing}
              loadingText="Updating…"
              disabled={!current || !next || Boolean(mismatch)}
            >
              Update password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function DangerZoneCard({
  email,
  onDelete,
  deleting,
  error,
}: {
  email: string;
  onDelete: () => void | Promise<void>;
  deleting: boolean;
  error?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const canDelete = confirmInput.trim().toLowerCase() === email.toLowerCase();

  return (
    <>
      <Card className="border-red/30">
        <CardHeader>
          <CardTitle className="text-red">Danger zone</CardTitle>
          <p className="mt-1 text-xs text-gry-d">
            Removing your account cancels all subscriptions and takes any live
            sites offline. This can&apos;t be undone.
          </p>
        </CardHeader>
        <CardBody>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gry">
              Delete your account and all associated data.
            </p>
            <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
              Delete account
            </Button>
          </div>
        </CardBody>
      </Card>

      <Modal
        isOpen={confirmOpen}
        onClose={() => {
          if (!deleting) {
            setConfirmOpen(false);
            setConfirmInput("");
          }
        }}
        title="Delete this account?"
        description="This permanently deletes your account, cancels subscriptions, and takes hosted sites offline."
        closeOnBackdrop={false}
        size="md"
      >
        <div className="space-y-4">
          <Alert tone="danger">
            This is irreversible. Make sure you&apos;ve exported any sites you
            want to keep.
          </Alert>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field
            label="Type your email to confirm"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={email}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ModalFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setConfirmOpen(false);
              setConfirmInput("");
            }}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onDelete}
            disabled={!canDelete || deleting}
            loading={deleting}
            loadingText="Deleting…"
          >
            Delete account
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
