import axios, { AxiosError, type AxiosRequestConfig } from "axios";

/**
 * Single axios instance for the whole app.
 * - The access token lives only in memory; the refresh token is an HttpOnly cookie that
 *   JavaScript cannot read. On a 401 we call /auth/refresh/ once (shared by concurrent
 *   requests) and replay the original request.
 * - Every request carries X-Organization-ID for the active organisation.
 */
let accessToken: string | null = null;
let organizationId: number | null = null;
let onSessionExpired: (() => void) | null = null;
let onSessionRefreshed: ((payload: SessionPayload) => void) | null = null;

export interface SessionPayload {
  access: string;
  user: Record<string, unknown>;
  organization: Record<string, unknown> | null;
  role: string | null;
  permissions: string[];
}

export const api = axios.create({ baseURL: "/api/v1", withCredentials: true });

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function setOrganizationId(id: number | null) {
  organizationId = id;
}
export function setSessionHandlers(expired: () => void, refreshed: (p: SessionPayload) => void) {
  onSessionExpired = expired;
  onSessionRefreshed = refreshed;
}

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.set("Authorization", `Bearer ${accessToken}`);
  if (organizationId) config.headers.set("X-Organization-ID", String(organizationId));
  return config;
});

let refreshing: Promise<SessionPayload> | null = null;

export function refreshSession(): Promise<SessionPayload> {
  if (!refreshing) {
    refreshing = axios
      .post<SessionPayload>("/api/v1/auth/refresh/", null, { withCredentials: true })
      .then((r) => {
        setAccessToken(r.data.access);
        onSessionRefreshed?.(r.data);
        return r.data;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const url = original?.url ?? "";
    if (error.response?.status === 401 && original && !original._retried && !url.includes("/auth/")) {
      original._retried = true;
      try {
        await refreshSession();
        return api(original);
      } catch {
        onSessionExpired?.();
      }
    }
    return Promise.reject(error);
  },
);

export interface ApiErrorBody {
  detail?: string;
  code?: string;
  errors?: Record<string, unknown>;
  request_id?: string;
}

/** Human-readable message for any API error. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return "Cannot reach the server. Check your connection.";
    const body = error.response.data as ApiErrorBody | undefined;
    if (body?.errors && body.code === "validation_error") {
      const first = flattenErrors(body.errors)[0];
      if (first) return first.field && first.field !== "non_field_errors" ? `${labelize(first.field)}: ${first.message}` : first.message;
    }
    if (body?.detail) return body.detail;
    if (error.response.status === 403) return "You do not have permission for this action.";
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

export function errorCode(error: unknown): string | undefined {
  return axios.isAxiosError(error) ? (error.response?.data as ApiErrorBody | undefined)?.code : undefined;
}

export function flattenErrors(errors: unknown, prefix = ""): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  if (Array.isArray(errors)) {
    errors.forEach((item, i) => {
      if (typeof item === "string") out.push({ field: prefix, message: item });
      else out.push(...flattenErrors(item, prefix ? `${prefix}.${i}` : String(i)));
    });
  } else if (errors && typeof errors === "object") {
    for (const [key, value] of Object.entries(errors)) out.push(...flattenErrors(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** Field errors keyed by field path, for react-hook-form setError. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!axios.isAxiosError(error)) return {};
  const body = error.response?.data as ApiErrorBody | undefined;
  if (!body?.errors) return {};
  const result: Record<string, string> = {};
  for (const { field, message } of flattenErrors(body.errors)) if (!(field in result)) result[field] = message;
  return result;
}

const labelize = (field: string) => field.split(".").pop()!.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export async function downloadFile(url: string, params: Record<string, unknown> = {}, fallbackName = "download") {
  const response = await api.get(url, { params, responseType: "blob" });
  const disposition = String(response.headers["content-disposition"] ?? "");
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const blobUrl = URL.createObjectURL(response.data as Blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

/** Opens a server-generated PDF in a new tab (authenticated fetch, then blob URL). */
export async function openPdf(url: string, params: Record<string, unknown> = {}) {
  const tab = window.open("", "_blank");
  try {
    const response = await api.get(url, { params, responseType: "blob" });
    const blobUrl = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
    if (tab) tab.location.href = blobUrl;
    else window.location.href = blobUrl;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
