import { Download } from "lucide-react";
import { toast } from "sonner";
import { downloadFile, errorMessage } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";

export function ExportMenu({ url, params = {}, formats = ["csv", "xlsx"], filename = "export" }: {
  url: string; params?: Record<string, unknown>; formats?: ("csv" | "xlsx" | "pdf")[]; filename?: string;
}) {
  const run = async (format: string) => {
    const id = toast.loading("Preparing export…");
    try {
      await downloadFile(url, { ...params, export: format }, `${filename}.${format}`);
      toast.success("Export downloaded", { id });
    } catch (e) {
      toast.error(errorMessage(e), { id });
    }
  };
  const labels = { csv: "CSV", xlsx: "Excel (.xlsx)", pdf: "PDF" };
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button icon={<Download className="h-3.5 w-3.5" />}>Export</Button>
      </MenuTrigger>
      <MenuContent>
        {formats.map((f) => <MenuItem key={f} onSelect={() => run(f)}>{labels[f]}</MenuItem>)}
      </MenuContent>
    </Menu>
  );
}
