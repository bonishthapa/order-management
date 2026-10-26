import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/** Filter state kept in the URL so lists are bookmarkable and the back button works. */
export function useUrlState(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => {
    const out: Record<string, string> = { ...defaults };
    params.forEach((v, k) => (out[k] = v));
    return out;
  }, [params]); // defaults are static per call site
  const set = useCallback((patch: Record<string, string | number | null | undefined>, resetPage = true) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      if (resetPage && !("page" in patch)) next.delete("page");
      return next;
    }, { replace: true });
  }, [setParams]);
  return [values, set] as const;
}
