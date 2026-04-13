import express from 'express';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Active sessions: Map<sessionId, { res, mcpProcess, buffer }>
const sessions = new Map();

function spawnMcpProcess() {
  return spawn(process.execPath, [join(__dirname, 'dist', 'server.js')], {
    env: { ...process.env, STRAVA_NO_BROWSER_AUTH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

app.get('/sse', (req, res) => {
  const sessionId = randomUUID();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

  const mcpProcess = spawnMcpProcess();
  const session = { res, mcpProcess, buffer: '' };
  sessions.set(sessionId, session);

  console.log(`[${sessionId.slice(0,8)}] session opened — pid ${mcpProcess.pid}`);

  mcpProcess.stderr.on('data', (chunk) => {
    process.stdout.write(`[mcp] ${chunk.toString('utf8')}`);
  });

  mcpProcess.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString('utf8');
    const nl = session.buffer.lastIndexOf('\n');
    if (nl === -1) return;

    const complete = session.buffer.slice(0, nl);
    session.buffer  = session.buffer.slice(nl + 1);

    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        JSON.parse(trimmed);
        res.write(`data: ${trimmed}\n\n`);
      } catch {
        console.log(`[wrapper] non-JSON line skipped: ${trimmed}`);
      }
    }
  });

  mcpProcess.on('exit', (code, signal) => {
    console.log(`[${sessionId.slice(0,8)}] process exited code=${code} signal=${signal}`);
    sessions.delete(sessionId);
    try { res.end(); } catch { /* ignore */ }
  });

  mcpProcess.on('error', (err) => {
    console.error(`[wrapper] spawn error: ${err.message}`);
    sessions.delete(sessionId);
    try { res.end(); } catch { /* ignore */ }
  });

  req.on('close', () => {
    sessions.delete(sessionId);
    try { mcpProcess.kill('SIGTERM'); } catch { /* ignore */ }
  });
});

app.post('/messages', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: `Session not found: ${sessionId}` });

  try {
    session.mcpProcess.stdin.write(JSON.stringify(req.body) + '\n', 'utf8');
    res.status(202).send('Accepted');
  } catch (err) {
    res.status(500).json({ error: 'Failed to forward message' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'strava-mcp-http-wrapper', sessions: sessions.size });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Strava MCP HTTP wrapper running on port ${PORT}`);
});
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
