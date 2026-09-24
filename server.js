/**
 * YouTube Audio Streaming API Server
 *
 * Version: 1.2.1
 *
 * Uses:
 *   - InnerTube for metadata/search
 *   - yt-dlp for YouTube extraction
 *   - FFmpeg for MP3 conversion
 *   - Optional YOUTUBE_COOKIES Railway variable
 *
 * MOMO-2:
 *   GET /api/streammp3/:videoId
 *
 * Existing endpoints:
 *   GET /api/search?q=...
 *   GET /api/video/:id
 *   GET /api/stream/:id
 *   GET /api/stream/:id/:itag
 *   GET /api/streammp3/:videoId
 *   GET /api/health
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
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

const VERSION = '1.2.2';

const YOUTUBE_COOKIE_FILE = path.join(
  os.tmpdir(),
  'youtube-cookies.txt'
);


// ============================================================
// GLOBAL PROCESS ERROR PROTECTION
// ============================================================

process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) {
    console.log(
      `[process] Ignoring expected ${err.code} during stream disconnect`
    );
    return;
  }

  console.error('[process] UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[process] UNHANDLED REJECTION:', err);
});


// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,HEAD,OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Range,Content-Type,Accept'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});


// ============================================================
// YOUTUBE COOKIE SUPPORT
// ============================================================

function prepareYoutubeCookies() {
  try {
    const cookies = process.env.YOUTUBE_COOKIES;

    if (!cookies || !cookies.trim()) {
      console.log('[cookies] YOUTUBE_COOKIES not configured');
      return false;
    }

    fs.writeFileSync(
      YOUTUBE_COOKIE_FILE,
      cookies,
      {
        encoding: 'utf8',
        mode: 0o600,
      }
    );

    console.log(
      `[cookies] YouTube cookies loaded securely`
    );

    return true;

  } catch (err) {
    console.error(
      '[cookies] Failed to prepare YouTube cookies:',
      err.message
    );

    return false;
  }
}


function getYoutubeCookieArgs() {
  try {
    if (
      process.env.YOUTUBE_COOKIES &&
      fs.existsSync(YOUTUBE_COOKIE_FILE)
    ) {
      return [
        '--cookies',
        YOUTUBE_COOKIE_FILE,
      ];
    }
  } catch (err) {
    console.error(
      '[cookies] Cookie file check failed:',
      err.message
    );
  }

  return [];
}


// Prepare cookies when server starts.
prepareYoutubeCookies();


// ============================================================
// HELPERS
// ============================================================

function isValidVideoId(videoId) {
  return (
    typeof videoId === 'string' &&
    /^[a-zA-Z0-9_-]{11}$/.test(videoId)
  );
}


function safeKill(child, signal = 'SIGKILL') {
  if (!child) return;

  try {
    if (!child.killed) {
      child.kill(signal);
    }
  } catch (err) {
    // Ignore process-already-exited errors.
  }
}


function attachChildErrorHandler(child, name) {
  if (!child) return;

  child.on('error', (err) => {
    if (
      err &&
      (
        err.code === 'EPIPE' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ERR_STREAM_DESTROYED'
      )
    ) {
      console.log(
        `[${name}] Expected pipe/connection error: ${err.code}`
      );
      return;
    }

    console.error(
      `[${name}] Process error:`,
      err.message
    );
  });
}


function attachStreamErrorHandler(stream, name) {
  if (!stream) return;

  stream.on('error', (err) => {
    if (
      err &&
      (
        err.code === 'EPIPE' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ERR_STREAM_DESTROYED'
      )
    ) {
      console.log(
        `[${name}] Expected stream error: ${err.code}`
      );
      return;
    }

    console.error(
      `[${name}] Stream error:`,
      err.message
    );
  });
}


// ============================================================
// CHECK YT-DLP
// ============================================================

function checkYtdlp() {
  return new Promise((resolve) => {

    const child = spawn(
      'yt-dlp',
      ['--version'],
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    attachChildErrorHandler(child, 'ytdlp-check');
    attachStreamErrorHandler(child.stdout, 'ytdlp-check-stdout');
    attachStreamErrorHandler(child.stderr, 'ytdlp-check-stderr');

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      resolve(
        code === 0 && output.trim()
          ? output.trim()
          : null
      );
    });
  });
}


// ============================================================
// CHECK FFMPEG
// ============================================================

function checkFfmpeg() {
  return new Promise((resolve) => {

    const child = spawn(
      'ffmpeg',
      ['-version'],
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    attachChildErrorHandler(child, 'ffmpeg-check');
    attachStreamErrorHandler(child.stdout, 'ffmpeg-check-stdout');
    attachStreamErrorHandler(child.stderr, 'ffmpeg-check-stderr');

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      resolve(
        code === 0 && output.length > 0
      );
    });
  });
}


// ============================================================
// ORIGINAL YT-DLP STREAM
// ============================================================

function streamViaYtdlp(
  res,
  videoIdOrUrl,
  itag
) {
  return new Promise((resolve) => {

    let finished = false;

    const cookieArgs = getYoutubeCookieArgs();

    const args = [];

    if (itag) {
      args.push(
        '-f',
        String(itag)
      );
    } else {
      args.push(
        '-f',
        'bestaudio/best'
      );
    }

    args.push(
      '-o',
      '-',
      '--no-playlist',
      '--no-warnings',
      '--no-progress'
    );

    if (cookieArgs.length) {
      args.push(...cookieArgs);
    }

    args.push(
      videoIdOrUrl.startsWith('http')
        ? videoIdOrUrl
        : `https://www.youtube.com/watch?v=${videoIdOrUrl}`
    );

    console.log(
      `📡 yt-dlp ${args.join(' ')}`
    );

    const ytdlp = spawn(
      'yt-dlp',
      args,
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    attachChildErrorHandler(ytdlp, 'yt-dlp');
    attachStreamErrorHandler(ytdlp.stdout, 'yt-dlp-stdout');
    attachStreamErrorHandler(ytdlp.stderr, 'yt-dlp-stderr');

    let stderrData = '';

    ytdlp.stderr.on('data', (data) => {
      const text = data.toString();

      stderrData += text;

      if (stderrData.length > 12000) {
        stderrData =
          stderrData.slice(-12000);
      }
    });

    ytdlp.stdout.on('error', (err) => {

      if (
        err &&
        (
          err.code === 'EPIPE' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ERR_STREAM_DESTROYED'
        )
      ) {
        console.log(
          `[yt-dlp] Expected stdout pipe error: ${err.code}`
        );
        return;
      }

      console.error(
        '[yt-dlp] stdout error:',
        err.message
      );
    });

    ytdlp.stdout.pipe(res);

    const cleanup = () => {
      if (finished) return;

      finished = true;

      safeKill(ytdlp);
    };

    res.on('close', cleanup);
    res.on('error', (err) => {

      if (
        err &&
        (
          err.code === 'EPIPE' ||
          err.code === 'ECONNRESET'
        )
      ) {
        console.log(
          `[stream] Client disconnected: ${err.code}`
        );
      } else {
        console.error(
          '[stream] Response error:',
          err.message
        );
      }

      cleanup();
    });

    ytdlp.on('close', (code) => {

      if (finished) {
        resolve();
        return;
      }

      if (code !== 0) {
        console.error(
          `❌ yt-dlp exited with code ${code}`
        );

        if (stderrData.trim()) {
          console.error(
            stderrData.trim()
          );
        }

        if (!res.headersSent) {
          res.status(500).json({
            error: 'yt-dlp stream failed',
            details: stderrData.trim()
          });
        }
      }

      finished = true;
      resolve();
    });

    ytdlp.on('error', () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    });
  });
}


// ============================================================
// ORIGINAL FALLBACK STREAM
// ============================================================

async function streamFallback(
  res,
  videoId
) {
  try {

    const info =
      await getVideoInfo(videoId);

    if (!info) {
      if (!res.headersSent) {
        res.status(404).json({
          error: 'Video not found'
        });
      }
      return;
    }

    const formats =
      info.streamingData &&
      (
        info.streamingData.adaptiveFormats ||
        info.streamingData.formats
      );

    if (!formats || !formats.length) {
      if (!res.headersSent) {
        res.status(404).json({
          error: 'No playable formats found'
        });
      }
      return;
    }

    const preferred =
      AUDIO_ITAGS_BY_PREFERENCE || [];

    let selected = null;

    for (const wanted of preferred) {
      selected =
        formats.find(
          (f) =>
            String(f.itag) ===
            String(wanted)
        );

      if (selected) break;
    }

    if (!selected) {
      selected =
        formats.find(
          (f) =>
            f.mimeType &&
            f.mimeType.includes('audio')
        );
    }

    if (!selected) {
      if (!res.headersSent) {
        res.status(404).json({
          error: 'No audio format available'
        });
      }
      return;
    }

    if (selected.url) {

      res.setHeader(
        'Content-Type',
        selected.mimeType ||
        'audio/mp4'
      );

      res.setHeader(
        'Cache-Control',
        'no-cache'
      );

      res.redirect(
        302,
        selected.url
      );

      return;
    }

    await streamViaYtdlp(
      res,
      videoId,
      selected.itag
    );

  } catch (err) {

    console.error(
      'Fallback stream error:',
      err.message
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Stream failed',
        details: err.message
      });
    }
  }
}


// ============================================================
// SEARCH
// ============================================================

app.get(
  '/api/search',
  async (req, res) => {

    try {

      const q =
        String(req.query.q || '').trim();

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit || '10',
              10
            ),
            1
          ),
          25
        );

      const type =
        String(
          req.query.type || 'video'
        ).toLowerCase();

      if (!q) {
        return res.status(400).json({
          error: 'Missing q parameter'
        });
      }

      let results;

      if (type === 'music') {
        results =
          await searchMusic(q);
      } else {
        results =
          await search(q);
      }

      if (!Array.isArray(results)) {
        results = [];
      }

      res.json({
        query: q,
        type,
        results:
          results.slice(0, limit)
      });

    } catch (err) {

      console.error(
        '/api/search error:',
        err.message
      );

      res.status(500).json({
        error: 'Search failed',
        details: err.message
      });
    }
  }
);


// ============================================================
// VIDEO INFO
// ============================================================

app.get(
  '/api/video/:id',
  async (req, res) => {

    try {

      const id =
        extractVideoId(
          req.params.id
        ) ||
        req.params.id;

      if (!isValidVideoId(id)) {
        return res.status(400).json({
          error: 'Invalid YouTube video ID'
        });
      }

      const info =
        await getVideoInfo(id);

      if (!info) {
        return res.status(404).json({
          error: 'Video not found'
        });
      }

      res.json(info);

    } catch (err) {

      console.error(
        '/api/video error:',
        err.message
      );

      res.status(500).json({
        error: 'Video info failed',
        details: err.message
      });
    }
  }
);


// ============================================================
// ORIGINAL STREAM ENDPOINT
// ============================================================

app.get(
  '/api/stream/:id/:itag?',
  async (req, res) => {

    const id =
      extractVideoId(
        req.params.id
      ) ||
      req.params.id;

    const itag =
      req.params.itag;

    console.log(
      `🎧 Stream request: ${id} (itag=${itag || 'auto'})`
    );

    if (!isValidVideoId(id)) {
      return res.status(400).json({
        error: 'Invalid YouTube video ID'
      });
    }

    try {

      res.setHeader(
        'Content-Type',
        'audio/mpeg'
      );

      res.setHeader(
        'Cache-Control',
        'no-cache'
      );

      res.setHeader(
        'Accept-Ranges',
        'none'
      );

      await streamViaYtdlp(
        res,
        id,
        itag
      );

    } catch (err) {

      console.error(
        '/api/stream error:',
        err.message
      );

      if (!res.headersSent) {
        await streamFallback(
          res,
          id
        );
      }
    }
  }
);


// ============================================================
// MOMO-2 MP3 STREAM
//
// YouTube -> yt-dlp -> FFmpeg -> MP3 -> MOMO-2
//
// IMPORTANT:
// Do NOT send HTTP 200 until FFmpeg has actually produced audio.
// If yt-dlp is blocked/fails before audio is produced, return 502.
// ============================================================

app.get(
  '/api/streammp3/:videoId',
  (req, res) => {

    const videoId = String(req.params.videoId || '').trim();

    console.log(`[streammp3] Request: ${videoId}`);

    if (!isValidVideoId(videoId)) {
      return res.status(400).json({
        error: 'Invalid YouTube video ID'
      });
    }

    let ytdlp = null;
    let ffmpeg = null;
    let responseStarted = false;
    let responseFinished = false;
    let clientDisconnected = false;
    let cleanupDone = false;
    let bytesFromYtdlp = 0;
    let bytesToClient = 0;
    let ytdlpExitCode = null;
    let ffmpegExitCode = null;
    let ytdlpStderr = '';
    let ffmpegStderr = '';

    const sendError = (status, message, details) => {
      if (responseStarted || res.headersSent || res.destroyed) return;

      responseStarted = true;

      const body = {
        error: message
      };

      if (details) {
        body.details = details;
      }

      try {
        res.status(status).json(body);
      } catch (err) {
        console.error('[streammp3] Error response failed:', err.message);
      }
    };

    const startAudioResponse = () => {
      if (responseStarted || res.destroyed) return;

      responseStarted = true;

      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Stream-Backend', 'yt-dlp-ffmpeg-mp3');
    };

    const killProcess = (child) => {
      if (!child) return;
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch (_) {}
    };

    const cleanup = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      killProcess(ytdlp);
      killProcess(ffmpeg);
    };

    const finishResponse = () => {
      if (responseFinished || clientDisconnected || res.destroyed) return;
      responseFinished = true;

      try {
        if (responseStarted && !res.writableEnded) {
          res.end();
        }
      } catch (err) {
        if (!['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
          console.error('[streammp3] Response end error:', err.message);
        }
      }
    };

    req.on('aborted', () => {
      clientDisconnected = true;
      console.log(`[streammp3] Client aborted: ${videoId}`);
      cleanup();
    });

    res.on('close', () => {
      if (!res.writableEnded && !responseFinished) {
        clientDisconnected = true;
        console.log(`[streammp3] Client disconnected: ${videoId}`);
        cleanup();
      }
    });

    res.on('error', (err) => {
      if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
        console.log(`[streammp3] Expected response error: ${err.code}`);
      } else {
        console.error('[streammp3] Response error:', err.message);
      }
      cleanup();
    });

    const cookieArgs = getYoutubeCookieArgs();

    // Android is tried first because the default YouTube client can trigger
    // "Sign in to confirm you're not a bot" on server/cloud IP addresses.
    const ytArgs = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--force-ipv4',
      '--extractor-args',
      'youtube:player_client=android',
      '-f',
      'bestaudio/best',
      '-o',
      '-'
    ];

    if (cookieArgs.length) {
      ytArgs.push(...cookieArgs);
    }

    ytArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

    console.log(`[streammp3] Starting yt-dlp: ${videoId}`);

    try {
      ytdlp = spawn('yt-dlp', ytArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      console.error('[streammp3] Cannot start yt-dlp:', err.message);
      sendError(502, 'yt-dlp could not be started', err.message);
      return;
    }

    attachChildErrorHandler(ytdlp, 'streammp3-ytdlp');
    attachStreamErrorHandler(ytdlp.stdout, 'streammp3-ytdlp-stdout');
    attachStreamErrorHandler(ytdlp.stderr, 'streammp3-ytdlp-stderr');

    ytdlp.stderr.on('data', (data) => {
      const text = data.toString();
      ytdlpStderr += text;
      if (ytdlpStderr.length > 16000) {
        ytdlpStderr = ytdlpStderr.slice(-16000);
      }
      console.log(`[streammp3] yt-dlp: ${text.trim()}`);
    });

    try {
      ffmpeg = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-i',
        'pipe:0',
        '-vn',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-b:a',
        '128k',
        '-codec:a',
        'libmp3lame',
        '-f',
        'mp3',
        'pipe:1'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      console.error('[streammp3] Cannot start FFmpeg:', err.message);
      cleanup();
      sendError(502, 'FFmpeg could not be started', err.message);
      return;
    }

    attachChildErrorHandler(ffmpeg, 'streammp3-ffmpeg');
    attachStreamErrorHandler(ffmpeg.stdin, 'streammp3-ffmpeg-stdin');
    attachStreamErrorHandler(ffmpeg.stdout, 'streammp3-ffmpeg-stdout');
    attachStreamErrorHandler(ffmpeg.stderr, 'streammp3-ffmpeg-stderr');

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      ffmpegStderr += text;
      if (ffmpegStderr.length > 12000) {
        ffmpegStderr = ffmpegStderr.slice(-12000);
      }
      console.log(`[streammp3] FFmpeg: ${text.trim()}`);
    });

    // Back-pressure-safe yt-dlp -> FFmpeg connection.
    ytdlp.stdout.on('data', (chunk) => {
      bytesFromYtdlp += chunk.length;
    });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ffmpeg.stdout.on('data', (chunk) => {
      if (clientDisconnected || cleanupDone) return;

      if (!responseStarted) {
        startAudioResponse();
      }

      bytesToClient += chunk.length;

      try {
        if (!res.destroyed && !res.writableEnded) {
          res.write(chunk);
        }
      } catch (err) {
        if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
          clientDisconnected = true;
          cleanup();
          return;
        }
        console.error('[streammp3] FFmpeg -> client error:', err.message);
        cleanup();
      }
    });

    ytdlp.stdout.on('error', (err) => {
      if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
        return;
      }
      console.error('[streammp3] yt-dlp stdout error:', err.message);
    });

    ffmpeg.stdout.on('error', (err) => {
      if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
        return;
      }
      console.error('[streammp3] FFmpeg stdout error:', err.message);
    });

    ytdlp.on('error', (err) => {
      if (clientDisconnected || cleanupDone) return;
      console.error('[streammp3] yt-dlp process error:', err.message);

      if (!responseStarted) {
        cleanup();
        sendError(502, 'YouTube audio extraction failed', err.message);
      }
    });

    ffmpeg.on('error', (err) => {
      if (clientDisconnected || cleanupDone) return;
      console.error('[streammp3] FFmpeg process error:', err.message);

      if (!responseStarted) {
        cleanup();
        sendError(502, 'MP3 conversion failed', err.message);
      }
    });

    ytdlp.on('close', (code) => {
      ytdlpExitCode = code;

      console.log(
        `[streammp3] yt-dlp exited with code ${code}; bytes=${bytesFromYtdlp}`
      );

      if (clientDisconnected || cleanupDone) return;

      // If yt-dlp produced nothing, there is no valid audio to send.
      if (code !== 0 && bytesFromYtdlp === 0 && !responseStarted) {
        const details = ytdlpStderr.trim().slice(-4000);
        console.error(`[streammp3] Extraction failed: ${details}`);
        cleanup();
        sendError(502, 'YouTube audio extraction failed', details);
        return;
      }

      // Closing stdout lets FFmpeg finish the MP3 file.
      try {
        if (ffmpeg && ffmpeg.stdin && !ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) {
          ffmpeg.stdin.end();
        }
      } catch (_) {}
    });

    ffmpeg.on('close', (code, signal) => {
      ffmpegExitCode = code;

      console.log(
        `[streammp3] FFmpeg exited with code ${code}` +
        (signal ? ` signal=${signal}` : '')
      );

      console.log(
        `[streammp3] Audio bytes: yt-dlp=${bytesFromYtdlp}, client=${bytesToClient}`
      );

      if (clientDisconnected) return;

      // FFmpeg produced no audio at all.
      if (!responseStarted && bytesToClient === 0) {
        const details =
          ffmpegStderr.trim().slice(-3000) ||
          ytdlpStderr.trim().slice(-3000) ||
          `yt-dlp exit=${ytdlpExitCode}, ffmpeg exit=${ffmpegExitCode}`;

        cleanup();
        sendError(502, 'No playable MP3 audio was produced', details);
        return;
      }

      if (code !== 0 && !responseStarted) {
        cleanup();
        sendError(502, 'FFmpeg MP3 conversion failed', ffmpegStderr.trim().slice(-3000));
        return;
      }

      finishResponse();
      cleanup();
    });
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  async (req, res) => {

    const ytdlpVersion =
      await checkYtdlp();

    const ffmpegAvailable =
      await checkFfmpeg();

    res.json({
      status: 'ok',
      service: 'YouTube Audio API',
      version: VERSION,
      noApiKeyRequired: true,
      engine: 'InnerTube + yt-dlp + FFmpeg',
      ytdlpAvailable: !!ytdlpVersion,
      ytdlpVersion: ytdlpVersion || null,
      ffmpegAvailable: !!ffmpegAvailable,
      youtubeCookiesConfigured:
        !!process.env.YOUTUBE_COOKIES,
      momoMp3Endpoint:
        '/api/streammp3/:videoId'
    });
  }
);


// ============================================================
// HOME / DOCUMENTATION
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.type('html').send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YouTube Audio API</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 900px;
      margin: 40px auto;
      padding: 20px;
      line-height: 1.6;
    }

    code {
      background: #f1f1f1;
      padding: 3px 6px;
      border-radius: 4px;
    }

    h1 {
      margin-bottom: 5px;
    }
  </style>
</head>

<body>

<h1>🎵 YouTube Audio Streaming API</h1>

<p>
Version: <b>${VERSION}</b>
</p>

<h2>Endpoints</h2>

<ul>
  <li>
    <code>/api/search?q=Tum%20Hi%20Ho</code>
  </li>

  <li>
    <code>/api/search?q=Tum%20Hi%20Ho&amp;type=music</code>
  </li>

  <li>
    <code>/api/video/VIDEO_ID</code>
  </li>

  <li>
    <code>/api/stream/VIDEO_ID</code>
  </li>

  <li>
    <code>/api/stream/VIDEO_ID/ITAG</code>
  </li>

  <li>
    <code>/api/streammp3/VIDEO_ID</code>
    <strong> ← MOMO-2 MP3 endpoint</strong>
  </li>

  <li>
    <code>/api/health</code>
  </li>
</ul>

<h2>MOMO-2 MP3</h2>

<p>
YouTube audio is extracted with yt-dlp,
converted by FFmpeg to MP3,
and streamed directly to MOMO-2.
</p>

<p>
Format:
<strong>MP3 / 44.1 kHz / stereo / 128 kbps</strong>
</p>

</body>
</html>
`);
  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');
    console.log('🎵 YouTube Audio Streaming API');
    console.log(`Version: ${VERSION}`);
    console.log(`Server: http://localhost:${PORT}`);
    console.log(
      `Health: http://localhost:${PORT}/api/health`
    );
    console.log(
      `MOMO MP3: http://localhost:${PORT}/api/streammp3/:videoId`
    );

    console.log(
      `YouTube cookies: ${
        process.env.YOUTUBE_COOKIES
          ? 'CONFIGURED'
          : 'NOT CONFIGURED'
      }`
    );

    console.log('');
  }
);
