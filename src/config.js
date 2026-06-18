import os from "node:os";
import path from "node:path";

export const homeDir = os.homedir();

export function getDataDir() {
  return process.env.CODEXMETER_DATA_DIR || path.join(homeDir, ".codexmeter");
}

export function getDashboardPort() {
  return Number(process.env.CODEXMETER_DASHBOARD_PORT || 8080);
}

export function getIngestPort() {
  return Number(process.env.CODEXMETER_INGEST_PORT || 4567);
}

export function getHost() {
  return process.env.CODEXMETER_HOST || "127.0.0.1";
}

export function getDbPath() {
  return path.join(getDataDir(), "usage.jsonl");
}

export function getStatePath() {
  return path.join(getDataDir(), "state.json");
}
