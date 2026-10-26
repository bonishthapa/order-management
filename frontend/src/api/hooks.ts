import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "./client";
import type { Paginated } from "./types";

export type Params = Record<string, string | number | boolean | null | undefined>;

export function cleanParams(params: Params): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Record<
    string, string | number | boolean>;
}

export function useList<T>(resource: string, params: Params = {}, options: Partial<UseQueryOptions<Paginated<T>>> = {}) {
  return useQuery<Paginated<T>>({
    queryKey: [resource, "list", cleanParams(params)],
    queryFn: async () => (await api.get<Paginated<T>>(`/${resource}/`, { params: cleanParams(params) })).data,
    placeholderData: keepPreviousData,
    ...options,
  });
}

/** Unpaginated or small option lists (masters). Returns an array either way. */
export function useOptions<T>(resource: string, params: Params = {}, enabled = true) {
  return useQuery<T[]>({
    queryKey: [resource, "options", cleanParams(params)],
    queryFn: async () => {
      const { data } = await api.get<T[] | Paginated<T>>(`/${resource}/`, { params: { page_size: 500, ...cleanParams(params) } });
      return Array.isArray(data) ? data : data.results;
    },
    staleTime: 60_000,
    enabled,
  });
}

export function useDetail<T>(resource: string, id: string | number | undefined, options: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({
    queryKey: [resource, "detail", String(id)],
    queryFn: async () => (await api.get<T>(`/${resource}/${id}/`)).data,
    enabled: id !== undefined && id !== "new",
    ...options,
  });
}

export function useGet<T>(key: unknown[], url: string, params: Params = {}, enabled = true) {
  return useQuery<T>({
    queryKey: [...key, cleanParams(params)],
    queryFn: async () => (await api.get<T>(url, { params: cleanParams(params) })).data,
    enabled,
  });
}

/** POST/PATCH/DELETE helper that invalidates the resource and reports success or failure. */
export function useApiMutation<TResult = unknown, TBody = unknown>(
  fn: (body: TBody) => Promise<TResult>,
  { invalidate = [], success, silentError }: { invalidate?: string[]; success?: string | ((r: TResult) => string); silentError?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, unknown, TBody>({
    mutationFn: fn,
    onSuccess: (result) => {
      invalidate.forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (success) toast.success(typeof success === "function" ? success(result) : success);
    },
    onError: (error) => {
      if (!silentError) toast.error(errorMessage(error));
    },
  });
}

/** Runs a document action (``/resource/:id/action/``) and refreshes the document. */
export function useDocumentAction<T>(resource: string, id: number | string | undefined, extraInvalidate: string[] = []) {
  const queryClient = useQueryClient();
  return useMutation<T, unknown, { action: string; body?: unknown; success?: string }>({
    mutationFn: async ({ action, body }) => (await api.post<T>(`/${resource}/${id}/${action}/`, body ?? {})).data,
    onSuccess: (data, vars) => {
      queryClient.setQueryData([resource, "detail", String(id)], data);
      queryClient.invalidateQueries({ queryKey: [resource] });
      [...extraInvalidate, "dashboard", "inventory/balances", "products"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      if (vars.success) toast.success(vars.success);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
}
