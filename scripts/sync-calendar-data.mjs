// Copies shared/bs-calendar.json to the backend and frontend so both sides convert dates with identical data.
import { copyFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "shared/bs-calendar.json");
const targets = [
  resolve(root, "backend/apps/calendar_utils/data/bs-calendar.json"),
  resolve(root, "frontend/src/calendar/bs-calendar.json"),
];
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
for (const target of targets) {
  copyFileSync(source, target);
  if (digest(target) !== digest(source)) throw new Error(`Copy mismatch: ${target}`);
  console.log(`synced ${target}`);
}
copyFileSync(resolve(root, "shared/bs-fixtures.json"), resolve(root, "frontend/src/calendar/bs-fixtures.json"));
