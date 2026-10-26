import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { DatePicker } from "@/calendar/DatePicker";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput } from "@/components/ui/Input";
import { formatQty } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Row { order_line: number; sku: string; product_name: string; unit: string; remaining: string; reserved: string; available: string;
  is_stock: boolean; track_batches: boolean; track_serials: boolean; quantity: string; batch_number: string; serials: string; product: number }

/** Records and posts a delivery (goods leave the warehouse; cost of goods sold is recognised). */
export function DeliveryDialog({ order, onClose }: { order: any; onClose: () => void }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIn(session?.organization?.timezone));
  const [vehicle, setVehicle] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  const query = useQuery({
    queryKey: ["sales-orders", order.id, "deliverable"],
    queryFn: async () => (await api.get(`/sales-orders/${order.id}/deliverable/`)).data,
  });
  const batches = useQuery({
    queryKey: ["batches-for-order", order.id],
    queryFn: async () => (await api.get("/inventory/batches/", { params: { warehouse: order.warehouse, in_stock: "true", page_size: 200 } })).data.results,
    enabled: !!query.data?.some((r: any) => r.track_batches),
  });
  const data: Row[] = rows ?? (query.data ?? []).map((r: any) => ({
    ...r, quantity: String(Math.min(Number(r.remaining), r.is_stock ? Number(r.available) : Number(r.remaining))), batch_number: "", serials: "",
  }));
  const update = (i: number, patch: Partial<Row>) => setRows(data.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    const lines = data.filter((r) => Number(r.quantity) > 0).map((r) => ({
      order_line: r.order_line, quantity: r.quantity, batch_number: r.batch_number,
      serial_numbers: r.serials.split(/[\s,]+/).filter(Boolean),
    }));
    if (!lines.length) return toast.error("Enter a quantity to deliver.");
    setSaving(true);
    let deliveryId: number | null = null;
    try {
      const { data: created } = await api.post("/deliveries/", { sales_order: order.id, date, vehicle_number: vehicle, lines });
      deliveryId = created.id;
      await api.post(`/deliveries/${created.id}/post/`);
      toast.success("Delivery posted; stock issued");
      ["sales-orders", "deliveries", "inventory/balances", "products", "dashboard"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onClose();
      navigate(`/sales/deliveries/${created.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      if (deliveryId) {
        toast.message("The delivery was saved as a draft so you can correct it.");
        navigate(`/sales/deliveries/${deliveryId}`);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Deliver ${order.number}`} size="xl"
      description="Quantities default to what is reserved or available. Delivering issues stock at FIFO cost."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={submit}>Post delivery</Button></>}>
      {query.isLoading ? <LoadingBlock /> : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Delivery date" required><DatePicker value={date} onChange={setDate} min={order.order_date} /></Field>
            <Field label="Vehicle number"><Input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="e.g. Ba 2 Kha 1234" /></Field>
          </div>
          <table className="w-full text-[13px]">
            <thead className="border-b border-line text-left text-xs text-slate-500">
              <tr><th className="py-1.5">Item</th><th className="text-right">To deliver</th><th className="text-right">Available</th><th className="w-28 text-right">Deliver now</th><th className="w-56 pl-3">Batch / serials</th></tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr key={r.order_line} className="border-b border-line align-top">
                  <td className="py-2"><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}</div></td>
                  <td className="num py-2">{formatQty(r.remaining)} {r.unit}</td>
                  <td className="num py-2">{r.is_stock ? formatQty(r.available) : "service"}</td>
                  <td className="py-1.5"><NumberInput aria-label={`Quantity for ${r.sku}`} value={r.quantity} onChange={(e) => update(i, { quantity: e.target.value })} /></td>
                  <td className="py-1.5 pl-3">
                    {r.track_batches && (
                      <select className="control" value={r.batch_number} onChange={(e) => update(i, { batch_number: e.target.value })} aria-label="Batch">
                        <option value="">Choose batch…</option>
                        {(batches.data ?? []).filter((b: any) => b.product === r.product).map((b: any) => (
                          <option key={b.id} value={b.batch_number}>{b.batch_number} · qty {formatQty(b.quantity)}{b.expiry_date ? ` · exp ${b.expiry_date}` : ""}</option>
                        ))}
                      </select>
                    )}
                    {r.track_serials && <Input placeholder="Serial numbers, comma separated" value={r.serials} onChange={(e) => update(i, { serials: e.target.value })} />}
                    {!r.track_batches && !r.track_serials && <span className="text-2xs text-slate-400">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
