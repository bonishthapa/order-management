import { Download, Paperclip, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, downloadFile, errorMessage } from "@/api/client";
import { useGet } from "@/api/hooks";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Page";
import { formatDateTime } from "@/utils/format";

interface Attachment { id: number; original_name: string; size: number; uploaded_by: string | null; created_at: string }

export function Attachments({ entityType, entityId, canUpload = true, canDelete = true }: {
  entityType: string; entityId: number; canUpload?: boolean; canDelete?: boolean;
}) {
  const key = ["attachments", entityType, entityId];
  const qc = useQueryClient();
  const { data } = useGet<Attachment[]>(key, "/attachments/", { entity_type: entityType, entity_id: entityId });
  const input = useRef<HTMLInputElement>(null);
  const upload = async (file: File) => {
    const form = new FormData();
    form.append("entity_type", entityType);
    form.append("entity_id", String(entityId));
    form.append("file", file);
    try {
      await api.post("/attachments/", form);
      toast.success("File attached");
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Panel title="Attachments" actions={canUpload && (
      <>
        <input ref={input} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.csv,.docx,.txt"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        <Button size="sm" icon={<Paperclip className="h-3.5 w-3.5" />} onClick={() => input.current?.click()}>Attach file</Button>
      </>
    )}>
      {!data?.length ? <p className="p-4 text-xs text-slate-500">No files attached.</p> : (
        <ul className="divide-y divide-line">
          {data.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
              <Paperclip className="h-3.5 w-3.5 text-slate-400" />
              <span className="min-w-0 flex-1 truncate">{a.original_name}</span>
              <span className="hidden text-2xs text-slate-400 sm:inline">{(a.size / 1024).toFixed(0)} KB · {a.uploaded_by} · {formatDateTime(a.created_at)}</span>
              <Button size="sm" variant="ghost" aria-label="Download" onClick={() => downloadFile(`/attachments/${a.id}/download/`, {}, a.original_name)}>
                <Download className="h-3.5 w-3.5" />
              </Button>
              {canDelete && (
                <Button size="sm" variant="ghost" aria-label="Remove" onClick={async () => {
                  try { await api.delete(`/attachments/${a.id}/`); qc.invalidateQueries({ queryKey: key }); } catch (e) { toast.error(errorMessage(e)); }
                }}><Trash2 className="h-3.5 w-3.5" /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
