"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import {
  AccountSettingsView,
  type AccountProfile,
} from "@/components/account-settings-view";

const INITIAL_PROFILE: AccountProfile = {
  fullName: "Sean Roberts",
  email: "sean@labelinteractive.com",
  organizationName: "Label Interactive",
};

export function SettingsDemo() {
  const [profile, setProfile] = useState<AccountProfile>(INITIAL_PROFILE);
  const [savingProfile, setSavingProfile] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [deletingAccount, setDeletingAccount] = useState(false);

  function handleSaveProfile(next: AccountProfile) {
    setSavingProfile(true);
    setTimeout(() => {
      setProfile(next);
      setSavingProfile(false);
    }, 700);
  }

  function handleChangePassword(current: string, _next: string) {
    setPasswordError(undefined);
    setPasswordChanged(false);
    setChangingPassword(true);
    setTimeout(() => {
      if (current !== "demo-current-password") {
        setPasswordError("That current password isn't right (mock: try 'demo-current-password').");
      } else {
        setPasswordChanged(true);
      }
      setChangingPassword(false);
    }, 900);
  }

  function handleDeleteAccount() {
    setDeletingAccount(true);
    setTimeout(() => {
      setDeletingAccount(false);
      alert("Mock: account deleted, redirect to /");
    }, 1500);
  }

  return (
    <WorkspaceShell
      navItems={[
        { label: "Projects", href: "/ui-kit/projects" },
        { label: "Billing", href: "/ui-kit/billing" },
        { label: "Settings", href: "/ui-kit/settings", active: true },
      ]}
      headerLeft={
        <>
          <Link
            href="/ui-kit/projects"
            className="truncate text-base font-semibold text-slate-900 hover:text-brand"
          >
            Label Interactive
          </Link>
          <Badge tone="neutral">
            <StatusDot tone="neutral" />
            Account
          </Badge>
        </>
      }
      sidebarFooter={
        <div className="space-y-1">
          <p className="truncate text-xs text-slate-500">Signed in as</p>
          <p className="truncate text-sm font-medium text-slate-900">
            {profile.email}
          </p>
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-900"
            onClick={() => alert("Sign out (mock)")}
          >
            Sign out
          </button>
        </div>
      }
    >
      <AccountSettingsView
        profile={profile}
        onSaveProfile={handleSaveProfile}
        savingProfile={savingProfile}
        onChangePassword={handleChangePassword}
        changingPassword={changingPassword}
        passwordChanged={passwordChanged}
        passwordError={passwordError}
        onDeleteAccount={handleDeleteAccount}
        deletingAccount={deletingAccount}
      />
    </WorkspaceShell>
  );
}
