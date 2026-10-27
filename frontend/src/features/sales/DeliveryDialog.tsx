import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { CellInput, CellSelect, FormDialog, FormField, FormGrid, useFormContext, useWatch } from "@/components/form";
import { BaseTable, col } from "@/components/table";
import { LoadingBlock } from "@/components/ui/Feedback";
import { formatQty } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Row { order_line: number; sku: string; product_name: string; unit: string; remaining: string; reserved: string; available: string;
  is_stock: boolean; track_batches: boolean; track_serials: boolean; quantity: string; batch_number: string; serials: string; product: number }

/** Records and posts a delivery (goods leave the warehouse; cost of goods sold is recognised). */
export function DeliveryDialog({ order, onClose }: { order: any; onClose: () => void }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const submit = async (values: Record<string, any>) => {
    const lines = (values.lines as Row[]).filter((r) => Number(r.quantity) > 0).map((r) => ({
      order_line: r.order_line, quantity: r.quantity, batch_number: r.batch_number, serial_numbers: r.serials.split(/[\s,]+/).filter(Boolean),
    }));
    if (!lines.length) throw new Error("Enter a quantity to deliver.");
    const { data: created } = await api.post("/deliveries/", { sales_order: order.id, date: values.date, vehicle_number: values.vehicle_number, lines });
    try {
      await api.post(`/deliveries/${created.id}/post/`);
      toast.success("Delivery posted; stock issued");
    } catch (e) {
      toast.error(errorMessage(e));
      toast.message("The delivery was saved as a draft so you can correct it.");
    }
    ["sales-orders", "deliveries", "inventory/balances", "products", "dashboard"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    navigate(`/sales/deliveries/${created.id}`);
  };

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Deliver ${order.number}`} size="xl" submitLabel="Post delivery"
      description="Quantities default to what is reserved or available. Delivering issues stock at FIFO cost."
      defaultValues={{ date: todayIn(session?.organization?.timezone), vehicle_number: "", lines: [] as Row[] }}
      onSubmit={submit}>
      <FormGrid columns={3}>
        <FormField name="date" label="Delivery date" type="date" required min={order.order_date} />
        <FormField name="vehicle_number" label="Vehicle number" placeholder="e.g. Ba 2 Kha 1234" />
      </FormGrid>
      <DeliveryLines order={order} />
    </FormDialog>
  );
}

function DeliveryLines({ order }: { order: any }) {
  const { setValue } = useFormContext();
  const rows = (useWatch({ name: "lines" }) ?? []) as Row[];
  const query = useQuery({
    queryKey: ["sales-orders", order.id, "deliverable"],
    queryFn: async () => (await api.get(`/sales-orders/${order.id}/deliverable/`)).data,
  });
  const batches = useQuery({
    queryKey: ["batches-for-order", order.id],
    queryFn: async () => (await api.get("/inventory/batches/", { params: { warehouse: order.warehouse, in_stock: "true", page_size: 200 } })).data.results,
    enabled: !!query.data?.some((r: any) => r.track_batches),
  });
  useEffect(() => {
    if (!query.data) return;
    setValue("lines", query.data.map((r: any): Row => ({
      ...r, quantity: String(Math.min(Number(r.remaining), r.is_stock ? Number(r.available) : Number(r.remaining))), batch_number: "", serials: "",
    })));
  }, [query.data, setValue]);
  if (query.isLoading) return <LoadingBlock />;
  return (
    <BaseTable rows={rows} rowKey={(r) => r.order_line} className="mt-3" columns={[
      col.custom("product_name", "Item", (r: Row) => <><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}</div></>),
      col.custom("remaining", "To deliver", (r: Row) => `${formatQty(r.remaining)} ${r.unit}`, { align: "right" }),
      col.custom("available", "Available", (r: Row) => (r.is_stock ? formatQty(r.available) : "service"), { align: "right" }),
      col.custom("quantity", "Deliver now", (r: Row) => (
        <CellInput number name={`lines.${rows.indexOf(r)}.quantity`} label={`Quantity for ${r.sku}`} />
      ), { width: 120 }),
      col.custom("tracking", "Batch / serials", (r: Row) => {
        const i = rows.indexOf(r);
        if (r.track_batches) {
          return <CellSelect name={`lines.${i}.batch_number`} label="Batch" emptyOption="Choose batch…"
            options={(batches.data ?? []).filter((b: any) => b.product === r.product).map((b: any) => ({
              value: b.batch_number, label: `${b.batch_number} · qty ${formatQty(b.quantity)}${b.expiry_date ? ` · exp ${b.expiry_date}` : ""}`,
            }))} />;
        }
        if (r.track_serials) return <CellInput name={`lines.${i}.serials`} label="Serial numbers" placeholder="Serial numbers, comma separated" />;
        return <span className="text-2xs text-slate-400">–</span>;
      }, { width: 240 }),
    ]} />
  );
}
