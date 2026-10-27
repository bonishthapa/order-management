/**
 * Guards the "one table, one form" rule: every table is BaseTable/DataGrid and every form is BaseForm.
 * If this fails, use the components from "@/components/table" and "@/components/form" instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : files(path);
    return /\.(tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const RULES: { pattern: RegExp; allowed: string[]; message: string }[] = [
  { pattern: /<table[\s>]/, allowed: ["components/table/BaseTable.tsx"], message: "use <BaseTable> from @/components/table" },
  { pattern: /ag-grid-react|AgGridReact/, allowed: ["components/table/DataGrid.tsx"], message: "use <ResourceList>/<DataGrid> from @/components/table" },
  { pattern: /<form[\s>]/, allowed: ["components/form/BaseForm.tsx"], message: "use <BaseForm>/<FormDialog> from @/components/form" },
  { pattern: /from "react-hook-form"/, allowed: ["components/form/", "components/document/LineItemsEditor.tsx"],
    message: "import form helpers from @/components/form" },
  { pattern: /from "@\/components\/table\/(?!index)[^"]+"/, allowed: ["components/"], message: "import tables from the @/components/table barrel" },
  { pattern: /from "@\/components\/form\/[^"]+"/, allowed: ["components/"], message: "import forms from the @/components/form barrel" },
];

describe("UI conventions", () => {
  const all = files(SRC).map((path) => ({ rel: relative(SRC, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));
  for (const rule of RULES) {
    it(`only base components may match ${rule.pattern}`, () => {
      const offenders = all.filter((f) => rule.pattern.test(f.text) && !rule.allowed.some((a) => f.rel.startsWith(a)));
      expect(offenders.map((f) => `${f.rel}: ${rule.message}`)).toEqual([]);
    });
  }
});
