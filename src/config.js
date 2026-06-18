import os from "node:os";
import path from "node:path";

export const homeDir = os.homedir();
export const dataDir = process.env.CODEXMETER_DATA_DIR || path.join(homeDir, ".codexmeter");
export const dbPath = path.join(dataDir, "usage.jsonl");
export const statePath = path.join(dataDir, "state.json");
export const dashboardPort = Number(process.env.CODEXMETER_DASHBOARD_PORT || 8080);
export const ingestPort = Number(process.env.CODEXMETER_INGEST_PORT || 4567);
export const host = process.env.CODEXMETER_HOST || "127.0.0.1";
