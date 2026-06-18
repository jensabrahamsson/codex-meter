import http from "node:http";
import { host, ingestPort } from "./config.js";
import { UsageStore } from "./store.js";

const store = new UsageStore();
await store.load();

function collectLogRecords(payload) {
  if (Array.isArray(payload)) return payload.flatMap(collectLogRecords);
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.resourceLogs)) {
    return payload.resourceLogs.flatMap((resourceLog) =>
      (resourceLog.scopeLogs || []).flatMap((scopeLog) =>
        (scopeLog.logRecords || scopeLog.records || []).flatMap(collectLogRecords)
      )
    );
  }
  if (Array.isArray(payload.scopeLogs)) {
    return payload.scopeLogs.flatMap((scopeLog) => (scopeLog.logRecords || scopeLog.records || []).flatMap(collectLogRecords));
  }
  if (Array.isArray(payload.logRecords) || Array.isArray(payload.records)) {
    return [...(payload.logRecords || payload.records)];
  }
  return [payload];
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
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
          const attributes = event.attributes || event.body?.attributes || event.body || event;
          const usage = attributes.usage || attributes.token_usage || event.usage || {};
          accepted.push(await store.append({
            id: attributes.id || event.id,
            timestamp: attributes.timestamp || event.timestamp || Date.now(),
            thread_id: attributes.thread_id || attributes.threadId,
            turn_id: attributes.turn_id || attributes.turnId,
            model: attributes.model,
            usage
          }));
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

let currentPort = ingestPort;

function listen(port) {
  currentPort = port;
  server.listen(port, host, () => {
    console.log(`Ingest server listening on http://${host}:${port}`);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    listen(currentPort + 1);
    return;
  }
  throw error;
});

listen(currentPort);
