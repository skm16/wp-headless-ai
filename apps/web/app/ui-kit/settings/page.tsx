import { notFound } from "next/navigation";
import { SettingsDemo } from "./settings-demo";

export const dynamic = "force-dynamic";

/**
 * Development-only demo of the account-level Settings page — §6 IA `/settings`.
 * Profile + password + danger-zone cards. Mock backends: profile save resolves
 * after a brief delay; password change rejects unless current === "demo-current-password";
 * delete account is two-step (button → modal that requires typing the email).
 */
export default function SettingsDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SettingsDemo />;
}
