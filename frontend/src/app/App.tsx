import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import axios from "axios";
import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { LoginPage } from "@/auth/LoginPage";
import { ForgotPasswordPage, ResetPasswordPage } from "@/auth/PasswordPages";
import { LoadingBlock } from "@/components/ui/Feedback";
import { AppLayout } from "@/layouts/AppLayout";
import { FiscalYearProvider } from "./FiscalYearContext";
import { AppRoutes } from "./routes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(axios.isAxiosError(error) && [400, 401, 403, 404].includes(error.response?.status ?? 0)) && count < 2,
    },
  },
});

function Authenticated({ children }: { children: ReactNode }) {
  const { status, session } = useAuth();
  if (status === "loading") return <LoadingBlock label="Starting…" className="h-screen" />;
  if (status === "anonymous") {
    return (
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (!session?.organization) return <NoOrganization />;
  return <FiscalYearProvider organizationId={session.organization.id}>{children}</FiscalYearProvider>;
}

const ChangePassword = lazy(() => import("@/features/account/AccountPage").then((m) => ({ default: m.ForcedPasswordChange })));

function NoOrganization() {
  const { logout } = useAuth();
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm font-medium text-slate-700">Your account is not active in any organisation.</p>
      <p className="text-xs text-slate-500">Ask a company administrator to add or reactivate your access.</p>
      <button className="link text-xs" onClick={() => logout()}>Sign out</button>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Authenticated>
            <MustChangePassword>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route path="*" element={<Suspense fallback={<LoadingBlock />}><AppRoutes /></Suspense>} />
                </Route>
              </Routes>
            </MustChangePassword>
          </Authenticated>
        </AuthProvider>
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "text-[13px]" }} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function MustChangePassword({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (session?.user.must_change_password) return <Suspense fallback={<LoadingBlock />}><ChangePassword /></Suspense>;
  return <>{children}</>;
}

