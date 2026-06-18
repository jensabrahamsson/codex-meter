import readline from "node:readline";
import { UsageStore } from "./store.js";

const store = new UsageStore();
await store.load();

function write(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

const tools = [
  {
    name: "usage_summary",
    description: "Return token usage summary for a rolling window.",
    inputSchema: {
      type: "object",
      properties: { window: { type: "string", enum: ["1m", "1h", "24h"] } },
      required: ["window"]
    }
  },
  {
    name: "usage_timeseries",
    description: "Return token usage timeseries for a rolling window.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["1h", "24h"] },
        bucket: { type: "string", enum: ["1m", "5m", "1h"] }
      },
      required: ["window", "bucket"]
    }
  },
  {
    name: "usage_recent_threads",
    description: "Return recently active thread identifiers.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 100 } }
    }
  }
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length);
    buffer = buffer.slice(start + length);
    handle(JSON.parse(body));
  }
});

async function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "codexmeter", version: "0.1.0" }
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params || {};
    if (name === "usage_summary") {
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(await store.summarize({ "1m": 60_000, "1h": 3_600_000, "24h": 86_400_000 }[args.window] || 3_600_000), null, 2) }] });
      return;
    }
    if (name === "usage_timeseries") {
      const bucketMs = args.bucket === "1h" ? 3_600_000 : args.bucket === "5m" ? 300_000 : 60_000;
      const windowMs = args.window === "24h" ? 86_400_000 : 3_600_000;
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(await store.timeseries(windowMs, bucketMs), null, 2) }] });
      return;
    }
    if (name === "usage_recent_threads") {
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(await store.recentThreads(args.limit || 10), null, 2) }] });
      return;
    }
  }
  if (message.id != null) reply(message.id, { error: { code: -32601, message: "Method not found" } });
}
