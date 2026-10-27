import { Printer } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { downloadFile, errorMessage, openPdf } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";

/** Opens the server-generated A4 PDF (real database record, numbered copy label) or downloads it. */
export function PrintButton({ url, filename, label = "Print / PDF", compact }: { url: string; filename: string; label?: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async (download: boolean, layout?: "compact") => {
    setBusy(true);
    try {
      if (download) await downloadFile(url, { download: 1 }, `${filename}.pdf`);
      else await openPdf(url, layout ? { layout } : {});
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button icon={<Printer className="h-3.5 w-3.5" />} loading={busy}>{label}</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={() => run(false)}>Open A4 PDF to print</MenuItem>
        {compact && <MenuItem onSelect={() => run(false, "compact")}>Receipt printer (80 mm)</MenuItem>}
        <MenuItem onSelect={() => run(true)}>Download PDF</MenuItem>
      </MenuContent>
    </Menu>
  );
}
