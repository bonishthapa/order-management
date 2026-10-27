import { Link } from "react-router-dom";
import { z } from "zod";
import { BaseForm, FormField } from "@/components/form";
import { Button } from "@/components/ui/Button";
import { useAuth } from "./AuthContext";

const schema = z.object({ email: z.string().email("Enter a valid email address"), password: z.string().min(1, "Enter your password") });

export function LoginPage() {
  const { login } = useAuth();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-brand-700 text-sm font-bold text-white">T</div>
          <span className="text-base font-semibold text-slate-800">Trade ERP</span>
        </div>
        <div className="panel p-6">
          <h1 className="text-base font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-[13px] text-slate-500">Use your company email address.</p>
          <BaseForm schema={schema} defaultValues={{ email: "", password: "" }} actions="none" warnUnsaved={false} className="mt-5"
            onSubmit={(values) => login(values.email, values.password)}>
            {({ formState }) => (
              <>
                <FormField name="email" label="Email" type="email" autoFocus />
                <FormField name="password" label="Password" type="password" />
                <Button type="submit" variant="primary" className="w-full" loading={formState.isSubmitting}>Sign in</Button>
              </>
            )}
          </BaseForm>
          <div className="mt-4 text-center text-xs">
            <Link to="/forgot-password" className="link">Forgot your password?</Link>
          </div>
        </div>
        {import.meta.env.DEV && (
          <p className="mt-4 text-center text-2xs text-slate-400">Demo data: admin@demo.erp / Demo@12345 (after <code>manage.py seed_demo</code>)</p>
        )}
      </div>
    </div>
  );
}
