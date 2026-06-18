# Codex Meter

Codex Meter is a local Codex usage meter and dashboard. It captures Codex telemetry on your machine, stores it in a small JSONL log, and renders rolling usage windows for the last minute, last hour, and last 24 hours.

Planned public repository name: `jensabrahamsson/codex-meter`.

The project is designed for local visibility first:
- a live dashboard runs on `http://127.0.0.1:8080`
- telemetry ingest runs on `http://127.0.0.1:4567/v1/logs`
- the plugin also exposes MCP tools for direct querying inside Codex

## How it works

Codex can export structured telemetry through OpenTelemetry logs. Codex Meter listens for those events locally, extracts token counts, and appends normalized usage records to `~/.codexmeter/usage.jsonl` by default.

Every new request to the dashboard or MCP tools reloads the data from disk. That keeps the dashboard, the ingest process, and the MCP server consistent even if they run as separate processes.

The dashboard aggregates four token buckets:
- input tokens
- cached input tokens
- output tokens
- reasoning output tokens

It renders:
- rolling totals for `1m`, `1h`, and `24h`
- a recent-thread list
- a simple timeline view for the selected time window

## Installation

Clone or place the `codexmeter` folder anywhere you want to develop from. The plugin manifest lives at `.codex-plugin/plugin.json`.

If you want the plugin to appear in Codex, the repository ships with a personal marketplace entry at `~/.agents/plugins/marketplace.json`.

## Configuration

### 1. Enable local telemetry export

Add this to `~/.codex/config.toml`:

```toml
[otel]
environment = "dev"
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4567/v1/logs" } }
```

If port `4567` is already in use, Codex Meter falls back to the next free port for local development. For a fixed setup, stop the conflicting local service first.

### 2. Start Codex Meter

```bash
cd codexmeter
npm start
```

The default ports are:
- dashboard: `8080`
- ingest: `4567`

The server falls back to the next free port if one of those ports is already occupied.

### 3. Open the dashboard

Visit:

```text
http://127.0.0.1:8080
```

If the fallback ports are used, the startup log prints the actual ports.

## Usage

### In the browser

Open the dashboard to see:
- current usage by window
- recent threads
- a live refresh cycle every few seconds

### In Codex

Use the bundled skill:

```text
@usage-dashboard
```

Or use the MCP tools:
- `usage_summary`
- `usage_timeseries`
- `usage_recent_threads`

### Direct API endpoints

- `GET /health`
- `GET /api/usage/summary?window=1m|1h|24h`
- `GET /api/usage/timeseries?window=1h|24h&bucket=1m|5m|1h`
- `GET /api/usage/recent-threads`

### Ingest endpoint

Codex Meter accepts OpenTelemetry-style JSON payloads on:

```text
POST /v1/logs
```

The ingest endpoint accepts payloads containing `resourceLogs`, `scopeLogs`, `logRecords`, or direct event objects with token usage fields.

## Data storage

Usage data is stored in:

```text
~/.codexmeter/usage.jsonl
~/.codexmeter/state.json
```

Set `CODEXMETER_DATA_DIR` if you want a different storage location.

## Environment variables

- `CODEXMETER_DATA_DIR`: storage directory
- `CODEXMETER_HOST`: bind host, defaults to `127.0.0.1`
- `CODEXMETER_INGEST_PORT`: ingest port, defaults to `4567`
- `CODEXMETER_DASHBOARD_PORT`: dashboard port, defaults to `8080`

## Security

Codex Meter is intentionally local-first. It does not require external network access to work.

Recommended hardening:
- keep the dashboard bound to localhost
- keep telemetry ingest bound to localhost
- do not expose the ingest endpoint to an untrusted network
- rotate or remove the local usage log if you want to clear historical data

The repository includes Dependabot and a security policy so dependency updates and vulnerability reporting have a place to live once the project is published publicly.

## Development

```bash
npm test
npm start
node src/mcp-server.js
```

The test suite covers aggregation and empty-window handling. The runtime smoke test should cover:
- dashboard startup
- ingest startup
- a synthetic telemetry post
- a successful usage summary response

## License

0BSD. See [LICENSE](LICENSE).
