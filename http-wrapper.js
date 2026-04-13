import express from 'express';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const sessions = new Map();

app.get('/sse', function(req, res) {
  const sessionId = randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write('event: endpoint\ndata: /messages?sessionId=' + sessionId + '\n\n');

  const mcpBin = join(__dirname, 'dist', 'server.js');
  const mcpProcess = spawn(process.execPath, [mcpBin], {
    env: Object.assign({}, process.env),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const session = { res: res, mcpProcess: mcpProcess, buffer: '' };
  sessions.set(sessionId, session);

  console.log('Session opened ' + sessionId.slice(0, 8) + ' pid=' + mcpProcess.pid);

  mcpProcess.stderr.on('data', function(chunk) {
    process.stdout.write('[mcp] ' + chunk.toString('utf8'));
  });

  mcpProcess.stdout.on('data', function(chunk) {
    session.buffer += chunk.toString('utf8');

    const nl = session.buffer.lastIndexOf('\n');
    if (nl === -1) return;

    const complete = session.buffer.slice(0, nl);
    session.buffer = session.buffer.slice(nl + 1);

    const lines = complete.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        JSON.parse(trimmed);
        res.write('data: ' + trimmed + '\n\n');
      } catch (e) {
        console.log('non-JSON line skipped');
      }
    }
  });

  mcpProcess.on('exit', function(code) {
    console.log('MCP process exited code=' + code);
    sessions.delete(sessionId);
    try { res.end(); } catch (e) { /* ignore */ }
  });

  mcpProcess.on('error', function(err) {
    console.error('Spawn error: ' + err.message);
    sessions.delete(sessionId);
    try { res.end(); } catch (e) { /* ignore */ }
  });

  req.on('close', function() {
    sessions.delete(sessionId);
    try { mcpProcess.kill('SIGTERM'); } catch (e) { /* ignore */ }
  });
});

app.post('/messages', function(req, res) {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    session.mcpProcess.stdin.write(JSON.stringify(req.body) + '\n', 'utf8');
    res.status(202).send('Accepted');
  } catch (err) {
    res.status(500).json({ error: 'Failed to forward message' });
  }
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    service: 'strava-mcp-http-wrapper',
    sessions: sessions.size
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', function() {
  console.log('Strava MCP HTTP wrapper running on port ' + PORT);
});
