/**
 * YouTube Audio Streaming API Server
 * No API keys. No headless browser. Just pure InnerTube magic.
 *
 * Uses InnerTube API for metadata/search + yt-dlp for actual audio streaming.
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   GET  /api/search?q=...         - Search YouTube (InnerTube)
 *   GET  /api/video/:id            - Get video info + audio stream list (InnerTube)
 *   GET  /api/stream/:id           - Stream best audio directly (yt-dlp backend)
 *   GET  /api/stream/:id/:itag     - Stream specific format by itag (yt-dlp backend)
 *   GET  /api/health               - Health check
 */

const path = require('path');
const express = require('express');
const { spawn } = require('child_process');
const {
  getVideoInfo,
  search,
  searchMusic,
  extractVideoId,
  AUDIO_ITAGS_BY_PREFERENCE,
} = require('./lib/innerTube');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// CORS + JSON + static files
// ──────────────────────────────────────────────
app.use(express.static(__dirname));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ──────────────────────────────────────────────
// Check if yt-dlp is available
// ──────────────────────────────────────────────
function checkYtdlp() {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--version'], { timeout: 5000 });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// ──────────────────────────────────────────────
// Stream audio via yt-dlp
// ──────────────────────────────────────────────
function streamViaYtdlp(res, videoIdOrUrl, itag) {
  // Check if yt-dlp is available
  const proc = spawn('yt-dlp', ['--version'], { timeout: 3000 });
  proc.on('error', () => {
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'yt-dlp not found. Install it: pip install yt-dlp',
        hint: 'brew install yt-dlp  or  pip3 install yt-dlp',
      });
    }
  });
  proc.on('close', (code) => {
    if (code !== 0) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'yt-dlp not available' });
      }
      return;
    }

    // yt-dlp is available, stream the audio
    const ytUrl = videoIdOrUrl.includes('youtube.com') || videoIdOrUrl.includes('youtu.be')
      ? videoIdOrUrl
      : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;

    const args = [
      '-f', itag ? String(itag) : '140/251/250/249/139/bestaudio',
      '-o', '-',           // Output to stdout
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      ytUrl,
    ];

    console.log(`  📡 yt-dlp ${args.join(' ')}`);

    const ytProc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 0,
    });

    // Set appropriate content type header
    const ext = itag === '251' || itag === '250' || itag === '249' ? 'audio/webm' : 'audio/mp4';
    res.setHeader('Content-Type', ext);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Stream-Backend', 'yt-dlp');

    // Capture stderr silently
    let stderr = '';
    ytProc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    ytProc.stdout.pipe(res);

    ytProc.on('error', (err) => {
      console.error('yt-dlp error:', err.message);
      if (!res.headersSent) {
        // Try fallback: direct InnerTube URL
        streamFallback(res, videoIdOrUrl, itag);
      }
    });

    ytProc.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        console.error('yt-dlp stderr:', stderr.slice(0, 500));
        streamFallback(res, videoIdOrUrl, itag);
      }
    });
  });
}

// ──────────────────────────────────────────────
// Fallback: stream directly from InnerTube URL
// ──────────────────────────────────────────────
async function streamFallback(res, videoIdOrUrl, itag) {
  try {
    const { getAudioStream } = require('./lib/innerTube');
    const videoId = extractVideoId(videoIdOrUrl) || videoIdOrUrl;
    const audio = await getAudioStream(videoId, itag || undefined);
    if (!audio || !audio.url) {
      return res.status(500).json({ error: 'No stream URL available' });
    }

    console.log(`  📡 Fallback InnerTube stream: itag=${audio.itag || itag}`);

    const https = require('https');
    const u = new URL(audio.url);
    const fetchReq = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'com.google.android.youtube/20.10.38',
      },
    }, (fetchRes) => {
      res.setHeader('Content-Type', audio.mimeType?.split(';')[0] || 'audio/mp4');
      res.setHeader('X-Stream-Backend', 'innertube-fallback');
      fetchRes.pipe(res);
    });

    fetchReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: err.message });
    });
    fetchReq.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

/** GET /api/search?q=<query>&limit=10&type=music */
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 10, type } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter ?q=' });

    const results = type === 'music'
      ? await searchMusic(q, parseInt(limit))
      : await search(q, parseInt(limit));

    res.json({ query: q, results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/video/:id — metadata + audio streams */
app.get('/api/video/:id', async (req, res) => {
  try {
    const info = await getVideoInfo(req.params.id);
    const { playerResponse, ...cleanInfo } = info;
    res.json(cleanInfo);
  } catch (err) {
    console.error('Video info error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/stream/:id[/:itag] — stream audio */
app.get('/api/stream/:id/:itag?', async (req, res) => {
  const videoId = extractVideoId(req.params.id) || req.params.id;
  const itag = req.params.itag ? parseInt(req.params.itag) : null;

  console.log(`\n🎧 Stream request: ${videoId}${itag ? ` (itag=${itag})` : ''}`);
  streamViaYtdlp(res, videoId, itag);
});

/** GET /api/health */
app.get('/api/health', async (req, res) => {
  const hasYtdlp = await checkYtdlp();
  res.json({
    status: 'ok',
    service: 'YouTube Audio API',
    version: '1.0.0',
    noApiKeyRequired: true,
    engine: 'InnerTube + yt-dlp',
    ytdlpAvailable: hasYtdlp,
  });
});

/** GET / — docs */
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>🎵 YouTube Audio Streaming API</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 820px; margin: 40px auto; padding: 0 20px; background: #0f0f0f; color: #e0e0e0; }
    h1 { color: #ff4444; }
    code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    pre { background: #1a1a1a; padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
    .endpoint { background: #1a1a1a; padding: 14px; border-radius: 8px; margin: 10px 0; border-left: 3px solid #ff4444; }
    .method { color: #4caf50; font-weight: bold; }
    a { color: #64b5f6; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 8px; }
    th { border-bottom: 1px solid #444; }
    td { border-bottom: 1px solid #222; }
  </style>
</head>
<body>
  <h1>🎵 YouTube Audio Streaming API</h1>
  <p>No API keys. No headless browser. No bullshit.</p>
  <p>Powered by <strong>InnerTube</strong> (metadata/search) + <strong>yt-dlp</strong> (audio streaming)</p>

  <div class="endpoint">
    <p><span class="method">GET</span> <code>/api/search?q=chill+lofi&limit=5</code></p>
    <p>Search YouTube. Add <code>&type=music</code> for music results.</p>
  </div>

  <div class="endpoint">
    <p><span class="method">GET</span> <code>/api/video/dQw4w9WgXcQ</code></p>
    <p>Get video metadata + all available audio streams.</p>
  </div>

  <div class="endpoint">
    <p><span class="method">GET</span> <code>/api/stream/dQw4w9WgXcQ</code></p>
    <p>Stream best quality audio. Works in <code>&lt;audio&gt;</code> tags, curl, VLC, etc.</p>
  </div>

  <div class="endpoint">
    <p><span class="method">GET</span> <code>/api/stream/dQw4w9WgXcQ/140</code></p>
    <p>Stream specific format: 140=AAC 128k, 251=Opus ~160k, 250=Opus ~70k, 249=Opus ~50k</p>
  </div>

  <h2>Examples</h2>
  <pre># Search
curl "http://localhost:${PORT}/api/search?q=study+lofi&limit=5" | jq

# Get video info
curl "http://localhost:${PORT}/api/video/dQw4w9WgXcQ" | jq

# Download audio
curl "http://localhost:${PORT}/api/stream/dQw4w9WgXcQ/140" -o song.m4a

# Play in VLC
vlc "http://localhost:${PORT}/api/stream/dQw4w9WgXcQ/251"</pre>

  <h2>Audio Formats</h2>
  <table>
    <tr><th>itag</th><th>Codec</th><th>Quality</th><th>Container</th></tr>
    <tr><td>251</td><td>Opus</td><td>~160 kbps</td><td>webm</td></tr>
    <tr><td>140</td><td>AAC LC</td><td>128 kbps</td><td>m4a</td></tr>
    <tr><td>250</td><td>Opus</td><td>~70 kbps</td><td>webm</td></tr>
    <tr><td>249</td><td>Opus</td><td>~50 kbps</td><td>webm</td></tr>
    <tr><td>139</td><td>AAC HE</td><td>48 kbps</td><td>m4a</td></tr>
  </table>

  <p style="margin-top: 40px; color: #555; font-size: 12px;">
    <strong>Requirements:</strong> <code>pip install yt-dlp</code> (or <code>brew install yt-dlp</code>)<br>
    Built with YouTube's InnerTube API. For educational purposes.
  </p>
</body>
</html>
  `);
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   🎵 YouTube Audio Streaming API           ║
║   No API keys. No browser. Just works.      ║
║                                              ║
║   Server: http://localhost:${PORT}              ║
║   Health: http://localhost:${PORT}/api/health    ║
╚══════════════════════════════════════════════╝
  `);
});
