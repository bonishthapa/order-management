/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TableColumn } from "./types";

type Extra<T> = Partial<TableColumn<T>>;

/**
 * Column helpers. Every table (BaseTable and DataGrid) is described with these, so numbers,
 * dates (AD/BS), statuses and document numbers look and align the same everywhere.
 */
export const col = {
  text: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "text", minWidth: 110, ...extra }),
  number: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "number", minWidth: 90, ...extra }),
  money: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "money", minWidth: 120, ...extra }),
  qty: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "qty", minWidth: 90, ...extra }),
  percent: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "percent", minWidth: 80, ...extra }),
  date: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "date", ...extra }),
  datetime: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "datetime", minWidth: 150, ...extra }),
  status: <T = any,>(key: string, header = "Status", labelKey?: string, extra: Extra<T> = {}): TableColumn<T> => ({
    key, header, type: "status", labelKey, minWidth: 120, ...extra,
  }),
  doc: <T = any,>(key: string, header: string, extra: Extra<T> = {}): TableColumn<T> => ({ key, header, type: "doc", minWidth: 150, pinned: true, ...extra }),
  custom: <T = any,>(key: string, header: React.ReactNode, render: (row: T) => React.ReactNode, extra: Extra<T> = {}): TableColumn<T> => ({
    key, header, render, ...extra,
  }),
};
