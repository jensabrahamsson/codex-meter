import fs from "node:fs";
import fsp from "node:fs/promises";
import { getDataDir, getDbPath, getStatePath } from "./config.js";

function ensureDir() {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function parseUsageJsonl(content) {
  const lines = content.trim() ? content.trim().split("\n").filter(Boolean) : [];
  return lines.map((line) => JSON.parse(line));
}

export async function readEventsFromFile(readFile, filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return parseUsageJsonl(content);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}

export function normalizeEvent(event) {
  const ts = Number(event.timestamp || Date.now());
  const usage = event.usage || event.token_usage || {};
  const inputTokens = toCount(usage.input_tokens ?? usage.input);
  const cachedInputTokens = toCount(usage.cached_input_tokens ?? usage.cached_input);
  const outputTokens = toCount(usage.output_tokens ?? usage.output);
  const reasoningOutputTokens = toCount(usage.reasoning_output_tokens ?? usage.reasoning_output);
  return {
    id: event.id || `${ts}-${Math.random().toString(16).slice(2)}`,
    timestamp: ts,
    threadId: event.thread_id || event.threadId || null,
    turnId: event.turn_id || event.turnId || null,
    model: event.model || null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    raw: event
  };
}

export class UsageStore {
  constructor() {
    ensureDir();
    this.events = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    this.events = await this.readEvents();
  }

  async readEvents() {
    return readEventsFromFile(fsp.readFile, getDbPath());
  }

  async refresh() {
    this.events = await this.readEvents();
  }

  async append(event) {
    const entry = normalizeEvent(event);
    this.events.push(entry);
    await fsp.appendFile(getDbPath(), `${JSON.stringify(entry)}\n`);
    await this.persistState();
    return entry;
  }

  async persistState() {
    const state = {
      lastEventAt: this.events.length ? this.events[this.events.length - 1].timestamp : null,
      totalEvents: this.events.length
    };
    await fsp.writeFile(getStatePath(), JSON.stringify(state, null, 2));
  }

  getEvents(windowMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    return this.events.filter((event) => event.timestamp >= cutoff);
  }

  async summarize(windowMs) {
    await this.refresh();
    const events = this.getEvents(windowMs);
    return aggregate(events);
  }

  async recentThreads(limit = 10) {
    await this.refresh();
    const seen = new Map();
    [...this.events].reverse().forEach((event) => {
      if (!event.threadId || seen.has(event.threadId)) return;
      seen.set(event.threadId, {
        threadId: event.threadId,
        lastEventAt: event.timestamp,
        model: event.model
      });
    });
    return [...seen.values()].slice(0, limit);
  }

  async timeseries(windowMs, bucketMs) {
    await this.refresh();
    const events = this.getEvents(windowMs);
    const cutoff = Date.now() - windowMs;
    const buckets = [];
    const firstBucketStart = Math.floor(cutoff / bucketMs) * bucketMs;
    for (let start = firstBucketStart; start < Date.now(); start += bucketMs) {
      buckets.push({
        start,
        end: start + bucketMs,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0
      });
    }
    if (buckets.length === 0) return buckets;
    for (const event of events) {
      const index = Math.floor((event.timestamp - buckets[0].start) / bucketMs);
      const bucket = buckets[index];
      if (!bucket) continue;
      bucket.inputTokens += event.inputTokens;
      bucket.cachedInputTokens += event.cachedInputTokens;
      bucket.outputTokens += event.outputTokens;
      bucket.reasoningOutputTokens += event.reasoningOutputTokens;
    }
    return buckets;
  }
}

export function aggregate(events) {
  const acc = events.reduce(
    (result, event) => {
      result.eventCount += 1;
      result.inputTokens += event.inputTokens;
      result.cachedInputTokens += event.cachedInputTokens;
      result.outputTokens += event.outputTokens;
      result.reasoningOutputTokens += event.reasoningOutputTokens;
      result.totalTokens += event.inputTokens + event.cachedInputTokens + event.outputTokens + event.reasoningOutputTokens;
      result.lastEventAt = Math.max(result.lastEventAt || 0, event.timestamp);
      return result;
    },
    {
      eventCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      lastEventAt: null,
      averageTokensPerEvent: 0
    }
  );
  if (acc.eventCount > 0) {
    acc.averageTokensPerEvent = Math.round(acc.totalTokens / acc.eventCount);
  }
  return acc;
}
