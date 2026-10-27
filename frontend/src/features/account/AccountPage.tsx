import { toast } from "sonner";
import { api } from "@/api/client";
import { BaseForm, FormField } from "@/components/form";
import { useAuth } from "@/auth/AuthContext";
import { PageHeader, Panel } from "@/components/ui/Page";

function PasswordForm({ onDone }: { onDone?: () => void }) {
  return (
    <BaseForm className="p-4" submitLabel="Change password" warnUnsaved={false}
      defaultValues={{ current_password: "", new_password: "", confirm: "" }}
      onSubmit={async (values, form) => {
        if (values.new_password !== values.confirm) {
          form.setError("confirm", { message: "The new passwords do not match." });
          return;
        }
        await api.post("/auth/change-password/", { current_password: values.current_password, new_password: values.new_password });
        toast.success("Password changed");
        form.reset();
        onDone?.();
      }}>
      <FormField name="current_password" label="Current password" type="password" required />
      <FormField name="new_password" label="New password" type="password" required hint="At least 10 characters; avoid common passwords." />
      <FormField name="confirm" label="Confirm new password" type="password" required />
    </BaseForm>
  );
}

export function AccountPage() {
  const { session, dateMode, reload } = useAuth();
  const user = session!.user;
  return (
    <>
      <PageHeader title="My account" subtitle={user.email} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profile">
          <BaseForm className="p-4" submitLabel="Save profile" warnUnsaved={false}
            defaultValues={{ full_name: user.full_name, phone: user.phone, date_display_mode: dateMode }}
            onSubmit={async (values) => {
              await api.patch("/auth/me/", values);
              await reload();
              toast.success("Profile saved");
            }}>
            <FormField name="full_name" label="Full name" required />
            <FormField name="phone" label="Phone" type="tel" />
            <FormField name="date_display_mode" label="Show dates in" type="select" emptyOption={false} hint="Overrides the company default for you only."
              options={[{ value: "AD_BS", label: "AD + BS" }, { value: "BS", label: "BS only" }, { value: "AD", label: "AD only" }]} />
          </BaseForm>
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
