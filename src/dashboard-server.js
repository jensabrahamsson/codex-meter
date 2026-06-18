import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageStore } from "./store.js";

const windows = { "1m": 60_000, "1h": 3_600_000, "24h": 86_400_000 };
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardHtmlPath = path.resolve(moduleDir, "../assets/dashboard.html");

export async function buildDashboardHtml() {
  const template = await fs.readFile(dashboardHtmlPath, "utf8");
  return template.replace("__WINDOWS__", JSON.stringify(windows));
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

export async function createDashboardRuntime() {
  const store = new UsageStore();
  await store.load();
  return { store };
}

export function createDashboardServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
      });
      res.end(await buildDashboardHtml());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/usage/summary") {
      const window = url.searchParams.get("window") || "1h";
      sendJson(res, 200, await store.summarize(windows[window] || windows["1h"]));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/usage/timeseries") {
      const window = url.searchParams.get("window") || "1h";
      const bucket = url.searchParams.get("bucket") || "1m";
      const bucketMs = bucket === "1h" ? 3_600_000 : bucket === "5m" ? 300_000 : 60_000;
      sendJson(res, 200, await store.timeseries(windows[window] || windows["1h"], bucketMs));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/usage/recent-threads") {
      sendJson(res, 200, await store.recentThreads());
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, events: store.events.length });
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  });
}

export function handlePortError(error, currentPort, listenNext) {
  if (error.code === "EADDRINUSE") {
    listenNext(currentPort + 1);
    return true;
  }
  throw error;
}
