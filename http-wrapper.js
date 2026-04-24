import express from 'express';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const sessions = new Map();

// ── RESPONSE FILTER ────────────────────────────────────────────────────────────
// Strips expensive Strava fields before forwarding to the agent.
// Reduces token cost by ~80% — removes GPS, splits, segments, laps.

const STRIP_FIELDS = new Set([
  'map',                    // GPS polyline — largest single field
  'splits_standard',        // miles version — not needed (metric only)
  'laps',                   // lap-by-lap breakdown arrays
  'segment_efforts',        // matched Strava segments
  'best_efforts',           // personal record segments
  'photos',
  'highlighted_kudosers',
  'gear',
  'device_name',
  'embed_token',
  'similar_activities',
  'start_latlng',
  'end_latlng',
  'timezone',
  'utc_offset',
  'location_city',
  'location_state',
  'location_country',
  'athlete_count',
  'manual',
  'private',
  'resource_state',
  'sport_type',             // duplicate of type
  'upload_id',
  'upload_id_str',
  'external_id',
  'from_accepted_tag',
  'has_kudoed',
  'hide_from_home',
  'visibility',
  'flagged',
  'kudos_count',
  'comment_count',
  'achievement_count',
]);

function trimActivity(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_FIELDS.has(k)) continue;
    if (k === 'splits_metric' && Array.isArray(v)) { out[k] = v.map(trimSplit); continue; }
    out[k] = v;
  }
  return out;
}


function trimSplit(s) {
  // Keep only fields needed for aerobic decoupling + pace fade detection
  return {
    split:               s.split,               // km number
    distance:            s.distance,            // metres
    elapsed_time:        s.elapsed_time,        // seconds
    moving_time:         s.moving_time,
    average_speed:       s.average_speed,       // m/s → pace calculable
    average_heartrate:   s.average_heartrate,
    elevation_difference: s.elevation_difference,
  };
}

function filterStravaContent(text) {
  try {
    const parsed = JSON.parse(text);

    // Array of activities
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.map(item => trimActivity(item)));
    }

    // Single activity (has id + type)
    if (parsed && typeof parsed === 'object' && parsed.id && parsed.type) {
      return JSON.stringify(trimActivity(parsed));
    }

    // Nested activities array
    if (parsed && parsed.activities && Array.isArray(parsed.activities)) {
      parsed.activities = parsed.activities.map(a => trimActivity(a));
      return JSON.stringify(parsed);
    }

    return text; // unknown shape — pass through
  } catch {
    return text; // not JSON — pass through
  }
}

function maybeFilter(jsonLine) {
  try {
    const msg = JSON.parse(jsonLine);
    if (!msg.result || !Array.isArray(msg.result.content)) return jsonLine;

    let modified = false;
    msg.result.content = msg.result.content.map(block => {
      if (block.type !== 'text' || !block.text) return block;
      const filtered = filterStravaContent(block.text);
      if (filtered !== block.text) { modified = true; return { ...block, text: filtered }; }
      return block;
    });

    return modified ? JSON.stringify(msg) : jsonLine;
  } catch {
    return jsonLine;
  }
}

// ── SSE SESSION ────────────────────────────────────────────────────────────────

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
        res.write('data: ' + maybeFilter(trimmed) + '\n\n');
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

// ── MESSAGES ───────────────────────────────────────────────────────────────────

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

// ── HEALTH ─────────────────────────────────────────────────────────────────────

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    service: 'strava-mcp-http-wrapper',
    sessions: sessions.size,
    filter: 'active — GPS/splits/laps/segments stripped'
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', function() {
  console.log('Strava MCP HTTP wrapper running on port ' + PORT);
  console.log('Response filter: ACTIVE');
});
