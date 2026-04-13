'use strict';

/**
 * APEX Coach — Strava MCP HTTP Wrapper
 *
 * Bridges the strava-mcp stdio transport to the MCP HTTP/SSE transport
 * so it can be deployed on Railway and connected to Anthropic Managed Agents.
 *
 * MCP HTTP/SSE transport:
 *   GET  /sse                        → establishes an SSE session
 *   POST /messages?sessionId=<id>    → sends a JSON-RPC message to the session
 *   GET  /health                     → health check for Railway
 *
 * Each SSE connection spawns one strava-mcp child process.
 * Messages from the client (POST /messages) are written to the child's stdin.
 * Responses from the child (stdout) are forwarded back via SSE.
 *
 * Deploy: Railway detects Node.js, runs `npm run build` then `npm start`.
 * Port:   Railway assigns $PORT automatically — wrapper listens on it.
 * URL:    Add the Railway-generated domain to Anthropic Managed Agents as
 *         the strava MCP server URL (no port needed — Railway handles it).
 */

const express = require('express');
const { spawn }  = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// ── Session store ──────────────────────────────────────────────────────────────
// Map<sessionId, { res: Response, mcpProcess: ChildProcess, buffer: string }>
const sessions = new Map();

// ── Helper: spawn one strava-mcp process ───────────────────────────────────────
function spawnMcpProcess() {
  const bin = path.join(__dirname, 'dist', 'server.js');

  const child = spawn(process.execPath, [bin], {
    env: {
      // All Railway Variables are inherited automatically.
      // Strava credentials (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET,
      // STRAVA_REFRESH_TOKEN) are set in Railway → Variables.
      ...process.env,
      // Disable the browser-based OAuth flow (we use env-var auth only).
      STRAVA_NO_BROWSER_AUTH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return child;
}

// ── GET /sse — establish an MCP session ───────────────────────────────────────
app.get('/sse', (req, res) => {
  const sessionId = randomUUID();

  // Standard SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Tell the client which URL to use for posting messages
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

  const mcpProcess = spawnMcpProcess();
  const session = { res, mcpProcess, buffer: '' };
  sessions.set(sessionId, session);

  log(`[${short(sessionId)}] session opened — pid ${mcpProcess.pid}`);

  // ── Bridge: child stderr → our stdout (for Railway logs) ──────────────────
  mcpProcess.stderr.on('data', (chunk) => {
    process.stdout.write(`[${short(sessionId)}] ${chunk.toString('utf8')}`);
  });

  // ── Bridge: child stdout → SSE ─────────────────────────────────────────────
  // strava-mcp sends one complete JSON-RPC object per line on stdout.
  mcpProcess.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString('utf8');

    // Find the last complete line
    const nl = session.buffer.lastIndexOf('\n');
    if (nl === -1) return; // no complete line yet

    const complete = session.buffer.slice(0, nl);
    session.buffer  = session.buffer.slice(nl + 1);

    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Validate JSON before forwarding — strava-mcp occasionally logs
      // plain-text startup messages before sending proper JSON-RPC
      try {
        JSON.parse(trimmed);
        res.write(`data: ${trimmed}\n\n`);
      } catch {
        log(`[${short(sessionId)}] non-JSON stdout line (skipped): ${trimmed}`);
      }
    }
  });

  // ── Child process exit ─────────────────────────────────────────────────────
  mcpProcess.on('exit', (code, signal) => {
    log(`[${short(sessionId)}] process exited — code=${code} signal=${signal}`);
    sessions.delete(sessionId);
    try { res.end(); } catch { /* SSE already closed */ }
  });

  mcpProcess.on('error', (err) => {
    log(`[${short(sessionId)}] spawn error — ${err.message}`);
    sessions.delete(sessionId);
    try { res.end(); } catch { /* ignore */ }
  });

  // ── Clean up when the Anthropic agent disconnects ─────────────────────────
  req.on('close', () => {
    log(`[${short(sessionId)}] client disconnected — killing child`);
    sessions.delete(sessionId);
    try { mcpProcess.kill('SIGTERM'); } catch { /* already gone */ }
  });
});

// ── POST /messages — receive MCP messages from the agent ──────────────────────
app.post('/messages', (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId query parameter' });
  }

  const session = sessions.get(sessionId);

  if (!session) {
    // Session may have expired or the process crashed
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  try {
    // Forward the JSON-RPC message to the child's stdin, one line per message
    const line = JSON.stringify(req.body) + '\n';
    session.mcpProcess.stdin.write(line, 'utf8');
    res.status(202).send('Accepted');
  } catch (err) {
    process.stderr.write(`[wrapper] stdin write failed: ${err.message}\n`);
    res.status(500).json({ error: 'Failed to forward message to MCP process' });
  }
});

// ── GET /health — Railway health checks + monitoring ──────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    service:  'strava-mcp-http-wrapper',
    sessions: sessions.size,
    uptime:   Math.floor(process.uptime()),
    node:     process.version,
  });
});

// ── Start the HTTP server ──────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, '0.0.0.0', () => {
  log(`Strava MCP HTTP wrapper started on port ${PORT}`);
  log(`  SSE endpoint:      GET  /sse`);
  log(`  Messages endpoint: POST /messages?sessionId=<id>`);
  log(`  Health check:      GET  /health`);
  log(`Add the Railway domain URL (no port) to Anthropic Managed Agents.`);
});

// ── Utils ──────────────────────────────────────────────────────────────────────
function short(id) { return id.slice(0, 8); }
function log(msg)  { process.stdout.write(`${new Date().toISOString()} ${msg}\n`); }
