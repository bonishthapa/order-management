import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { BaseForm, FormField } from "@/components/form";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Feedback";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
      <div className="panel w-full max-w-sm p-6">
        <h1 className="mb-4 text-base font-semibold text-slate-900">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  return (
    <Shell title="Reset your password">
      {sent ? (
        <Alert tone="success">If the address belongs to an account, a reset link is on its way.</Alert>
      ) : (
        <BaseForm defaultValues={{ email: "" }} actions="none" warnUnsaved={false}
          onSubmit={async (values) => { await api.post("/auth/password-reset/", values); setSent(true); }}>
          {({ formState }) => (
            <>
              <FormField name="email" label="Email" type="email" required autoFocus />
              <Button type="submit" variant="primary" className="w-full" loading={formState.isSubmitting}>Send reset link</Button>
            </>
          )}
        </BaseForm>
      )}
      <div className="mt-4 text-center text-xs"><Link to="/" className="link">Back to sign in</Link></div>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <Shell title="Choose a new password">
      <BaseForm defaultValues={{ new_password: "", confirm: "" }} actions="none" warnUnsaved={false} errorFieldMap={{ token: "new_password" }}
        onSubmit={async (values, form) => {
          if (values.new_password !== values.confirm) {
            form.setError("confirm", { message: "The passwords do not match." });
            return;
          }
          await api.post("/auth/password-reset/confirm/", { uid: params.get("uid"), token: params.get("token"), new_password: values.new_password });
          toast.success("Password changed. Sign in with your new password.");
          navigate("/");
        }}>
        {({ formState }) => (
          <>
            <FormField name="new_password" label="New password" type="password" required hint="At least 10 characters; not a common password." />
            <FormField name="confirm" label="Confirm password" type="password" required />
            <Button type="submit" variant="primary" className="w-full" loading={formState.isSubmitting}>Set password</Button>
          </>
        )}
      </BaseForm>
    </Shell>
  );
}
