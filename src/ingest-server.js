import http from "node:http";
import { UsageStore } from "./store.js";

export async function createIngestRuntime() {
  const store = new UsageStore();
  await store.load();
  return { store };
}

export function collectLogRecords(payload) {
  if (Array.isArray(payload)) return payload.flatMap(collectLogRecords);
  if (!payload || typeof payload !== "object") return [];
  const resourceLogs = Array.isArray(payload.resourceLogs) ? payload.resourceLogs : null;
  if (resourceLogs) {
    return resourceLogs.flatMap((resourceLog) => collectLogRecords({ scopeLogs: resourceLog.scopeLogs || [] }));
  }
  const scopeLogs = Array.isArray(payload.scopeLogs) ? payload.scopeLogs : null;
  if (scopeLogs) {
    return scopeLogs.flatMap((scopeLog) => collectLogRecords({ logRecords: scopeLog.logRecords || scopeLog.records || [] }));
  }
  const recordList = Array.isArray(payload.logRecords) ? payload.logRecords : null;
  if (recordList) return [...recordList];
  const fallbackRecords = Array.isArray(payload.records) ? payload.records : null;
  if (fallbackRecords) return [...fallbackRecords];
  return [payload];
}

export function extractUsageEvent(event) {
  const attributes = event.attributes || event.body?.attributes || event.body || event;
  const usage = attributes.usage || attributes.token_usage || event.usage || {};
  return {
    id: attributes.id || event.id,
    timestamp: attributes.timestamp || event.timestamp || Date.now(),
    thread_id: attributes.thread_id || attributes.threadId,
    turn_id: attributes.turn_id || attributes.turnId,
    model: attributes.model,
    usage
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createIngestServer(store) {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, events: store.events.length });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/logs") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const events = collectLogRecords(payload);
          const accepted = [];
          for (const event of events) {
            accepted.push(await store.append(extractUsageEvent(event)));
          }
          sendJson(res, 200, { ok: true, accepted: accepted.length });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  });
}

export function handleIngestPortError(error, currentPort, listenNext) {
  if (error.code === "EADDRINUSE") {
    listenNext(currentPort + 1);
    return true;
  }
  throw error;
}
