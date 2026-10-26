import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, refreshSession, setAccessToken, setOrganizationId, setSessionHandlers, type SessionPayload } from "@/api/client";
import type { DateDisplayMode, Session } from "@/api/types";
import { setNumberLocale } from "@/utils/format";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  session: Session | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrganization: (id: number) => Promise<void>;
  can: (permission: string | string[]) => boolean;
  dateMode: DateDisplayMode;
  setDateMode: (mode: DateDisplayMode) => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const ORG_KEY = "erp.organization";

function readStoredOrg(): number | null {
  try {
    const v = localStorage.getItem(ORG_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [session, setSession] = useState<Session | null>(null);

  const apply = useCallback((payload: SessionPayload | Session) => {
    const s = payload as Session;
    setSession({ user: s.user, organization: s.organization, role: s.role, permissions: s.permissions });
    if (s.organization) {
      setOrganizationId(s.organization.id);
      setNumberLocale(s.organization.locale);
      try {
        localStorage.setItem(ORG_KEY, String(s.organization.id));
      } catch {
        /* storage unavailable: the organisation is simply not remembered */
      }
    }
    setStatus("authenticated");
  }, []);

  useEffect(() => {
    setOrganizationId(readStoredOrg());
    setSessionHandlers(
      () => {
        setAccessToken(null);
        setSession(null);
        setStatus("anonymous");
        queryClient.clear();
      },
      (p) => apply(p),
    );
    refreshSession()
      .then(apply)
      .catch(() => setStatus("anonymous"));
  }, [apply, queryClient]);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await api.post<SessionPayload>("/auth/login/", { email, password });
    setAccessToken(data.access);
    apply(data);
    // If a different organisation was remembered and the user belongs to it, switch to it.
    const remembered = readStoredOrg();
    if (remembered && data.organization && remembered !== data.organization.id
        && (data.user as unknown as Session["user"]).memberships.some((m) => m.organization === remembered)) {
      setOrganizationId(remembered);
      const me = await api.get<Session>("/auth/me/");
      apply(me.data);
    }
  }, [apply]);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout/");
    } finally {
      setAccessToken(null);
      setSession(null);
      setStatus("anonymous");
      queryClient.clear();
    }
  }, [queryClient]);

  const switchOrganization = useCallback(async (id: number) => {
    setOrganizationId(id);
    const me = await api.get<Session>("/auth/me/");
    queryClient.clear();
    apply(me.data);
  }, [apply, queryClient]);

  const reload = useCallback(async () => {
    const me = await api.get<Session>("/auth/me/");
    apply(me.data);
  }, [apply]);

  const setDateMode = useCallback(async (mode: DateDisplayMode) => {
    const me = await api.patch<Session>("/auth/me/", { date_display_mode: mode });
    apply(me.data);
  }, [apply]);

  const value = useMemo<AuthState>(() => {
    const perms = new Set(session?.permissions ?? []);
    return {
      status,
      session,
      login,
      logout,
      switchOrganization,
      reload,
      can: (p) => (Array.isArray(p) ? p.some((x) => perms.has(x)) : perms.has(p)),
      dateMode: (session?.user.date_display_mode || session?.organization?.date_display_mode || "AD_BS") as DateDisplayMode,
      setDateMode,
    };
  }, [status, session, login, logout, switchOrganization, reload, setDateMode]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useOrganization() {
  const { session } = useAuth();
  return session?.organization ?? null;
}
