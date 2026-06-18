import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

spawn(process.execPath, [path.join(root, "ingest-server.js")], { stdio: "inherit" });
spawn(process.execPath, [path.join(root, "dashboard-server.js")], { stdio: "inherit" });
