import fs from "node:fs";
import path from "node:path";

const roots = ["apps/desktop/src", "packages/parsers/src"];
const offenders = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    offenders.push(full);
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) {
    walk(root);
  }
}

if (offenders.length > 0) {
  console.error("Found generated JS files under source directories:");
  for (const file of offenders) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log("No generated JS files detected in source directories.");
