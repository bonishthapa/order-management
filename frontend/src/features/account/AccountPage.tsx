import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Select } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import type { DateDisplayMode } from "@/api/types";

function PasswordForm({ onDone }: { onDone?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form className="space-y-3 p-4" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      if (next !== confirm) return setError("The new passwords do not match.");
      setSaving(true);
      try {
        await api.post("/auth/change-password/", { current_password: current, new_password: next });
        toast.success("Password changed");
        setCurrent(""); setNext(""); setConfirm("");
        onDone?.();
      } catch (err) { setError(errorMessage(err)); }
      setSaving(false);
    }}>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Current password" htmlFor="cur"><Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="New password" htmlFor="new" hint="At least 10 characters; avoid common passwords."><Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field label="Confirm new password" htmlFor="conf"><Input id="conf" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      <Button type="submit" variant="primary" loading={saving}>Change password</Button>
    </form>
  );
}

export function AccountPage() {
  const { session, dateMode, setDateMode, reload } = useAuth();
  const user = session!.user;
  const [name, setName] = useState(user.full_name);
  const [phone, setPhone] = useState(user.phone);
  return (
    <>
      <PageHeader title="My account" subtitle={user.email} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profile">
          <div className="space-y-3 p-4">
            <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="Show dates in" hint="Overrides the company default for you only.">
              <Select value={dateMode} onChange={(e) => setDateMode(e.target.value as DateDisplayMode)}>
                <option value="AD_BS">AD + BS</option><option value="BS">BS only</option><option value="AD">AD only</option>
              </Select>
            </Field>
            <Button variant="primary" onClick={async () => {
              try { await api.patch("/auth/me/", { full_name: name, phone }); await reload(); toast.success("Profile saved"); }
              catch (e) { toast.error(errorMessage(e)); }
            }}>Save profile</Button>
          </div>
        </Panel>
        <Panel title="Password"><PasswordForm /></Panel>
      </div>
    </>
  );
}

export function ForcedPasswordChange() {
  const { reload, logout } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
      <div className="panel w-full max-w-sm">
        <div className="border-b border-line px-4 py-3">
          <h1 className="text-sm font-semibold">Set a new password</h1>
          <p className="mt-0.5 text-xs text-slate-500">Your administrator issued a temporary password. Choose your own to continue.</p>
        </div>
        <PasswordForm onDone={() => reload()} />
        <div className="border-t border-line px-4 py-2 text-right"><button className="link text-xs" onClick={() => logout()}>Sign out</button></div>
      </div>
    </div>
  );
}
