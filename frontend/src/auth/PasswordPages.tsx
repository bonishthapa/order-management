import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

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
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  return (
    <Shell title="Reset your password">
      {sent ? (
        <Alert tone="success">If the address belongs to an account, a reset link is on its way.</Alert>
      ) : (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          try { await api.post("/auth/password-reset/", { email }); setSent(true); } catch (err) { toast.error(errorMessage(err)); }
          setLoading(false);
        }}>
          <Field label="Email" htmlFor="email"><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" variant="primary" className="w-full" loading={loading}>Send reset link</Button>
        </form>
      )}
      <div className="mt-4 text-center text-xs"><Link to="/" className="link">Back to sign in</Link></div>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <Shell title="Choose a new password">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (password !== confirm) return setError("The passwords do not match.");
        setLoading(true);
        try {
          await api.post("/auth/password-reset/confirm/", { uid: params.get("uid"), token: params.get("token"), new_password: password });
          toast.success("Password changed. Sign in with your new password.");
          navigate("/");
        } catch (err) { setError(errorMessage(err)); }
        setLoading(false);
      }}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="New password" htmlFor="pw" hint="At least 10 characters; not a common password.">
          <Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" htmlFor="pw2"><Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Set password</Button>
      </form>
    </Shell>
  );
}
