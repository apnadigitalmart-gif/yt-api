/**
 * YouTube Audio Streaming API Server
 *
 * Version: 1.3.0
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

const VERSION = '1.3.0';

// PO-token provider configuration. The recommended yt-dlp setup is
// bgutil-ytdlp-pot-provider with the mweb YouTube client.
// Example: http://127.0.0.1:4416 when the provider runs beside this service.
const YOUTUBE_POT_PROVIDER_URL = (
  process.env.YOUTUBE_POT_PROVIDER_URL ||
  'http://127.0.0.1:4416'
).trim();

const YOUTUBE_POT_ENABLED =
  process.env.YOUTUBE_POT_ENABLED !== 'false' &&
  process.env.YOUTUBE_POT_PROVIDER_URL !== '';

const YOUTUBE_POT_CLIENT =
  (process.env.YOUTUBE_POT_CLIENT || 'mweb').trim();

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


function getYoutubePotArgs() {
  if (!YOUTUBE_POT_ENABLED || !YOUTUBE_POT_PROVIDER_URL) {
    return [];
  }

  return [
    '--extractor-args',
    `youtube:player-client=${YOUTUBE_POT_CLIENT}`,
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${YOUTUBE_POT_PROVIDER_URL}`
  ];
}


function appendYoutubeExtractionArgs(args) {
  const potArgs = getYoutubePotArgs();

  if (potArgs.length) {
    args.push(...potArgs);
  }

  // yt-dlp's YouTube extractor may need a JavaScript runtime for current
  // player/n-signature solving. Deno is used when available on Railway.
  if (process.env.YOUTUBE_JS_RUNTIME) {
    args.push(
      '--js-runtimes',
      process.env.YOUTUBE_JS_RUNTIME
    );
  }

  return args;
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

    appendYoutubeExtractionArgs(args);

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
// YouTube
//    ↓
// yt-dlp
//    ↓
// FFmpeg
//    ↓
// MP3 128 kbps / 44.1 kHz stereo
//    ↓
// MOMO-2
// ============================================================

app.get(
  '/api/streammp3/:videoId',
  async (req, res) => {

    const videoId = String(req.params.videoId || '').trim();

    console.log(`🎵 MOMO-2 MP3 STREAM: ${videoId}`);

    if (!isValidVideoId(videoId)) {
      return res.status(400).json({
        error: 'Invalid YouTube video ID'
      });
    }

    let clientDisconnected = false;
    let responseFinished = false;
    let activeYtdlp = null;
    let activeFfmpeg = null;

    const extractionStrategies = [
      {
        name: 'mweb+PO-token',
        args: [
          '--extractor-args',
          `youtube:player-client=${YOUTUBE_POT_CLIENT}`,
          '--extractor-args',
          `youtubepot-bgutilhttp:base_url=${YOUTUBE_POT_PROVIDER_URL}`
        ]
      },
      {
        name: 'web-embedded',
        args: [
          '--extractor-args',
          'youtube:player-client=web_embedded'
        ]
      },
      {
        name: 'web-music',
        args: [
          '--extractor-args',
          'youtube:player-client=web_music'
        ]
      }
    ];

    const cookieArgs = getYoutubeCookieArgs();

    function killActiveProcesses() {
      if (activeYtdlp) safeKill(activeYtdlp);
      if (activeFfmpeg) safeKill(activeFfmpeg);
    }

    req.on('aborted', () => {
      clientDisconnected = true;
      killActiveProcesses();
    });

    res.on('close', () => {
      if (!res.writableEnded && !responseFinished) {
        clientDisconnected = true;
        killActiveProcesses();
      }
    });

    res.on('error', (err) => {
      if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
        clientDisconnected = true;
      } else {
        console.error('[streammp3] Response error:', err.message);
      }
      killActiveProcesses();
    });

    async function runStrategy(strategy) {
      return new Promise((resolve) => {
        if (clientDisconnected) return resolve({ ok: false, aborted: true });

        let ytdlp = null;
        let ffmpeg = null;
        let settled = false;
        let bytesFromYtdlp = 0;
        let bytesToClient = 0;
        let ytdlpStderr = '';
        let ffmpegStderr = '';
        let ffmpegStarted = false;
        let outputStarted = false;

        activeYtdlp = null;
        activeFfmpeg = null;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (activeYtdlp === ytdlp) activeYtdlp = null;
          if (activeFfmpeg === ffmpeg) activeFfmpeg = null;
          resolve(result);
        };

        const commonArgs = [
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '--force-ipv4',
          '--retries', '2',
          '--fragment-retries', '2',
          '-f', 'bestaudio/best',
          '-o', '-'
        ];

        if (cookieArgs.length) commonArgs.push(...cookieArgs);
        commonArgs.push(...strategy.args);

        if (process.env.YOUTUBE_JS_RUNTIME) {
          commonArgs.push('--js-runtimes', process.env.YOUTUBE_JS_RUNTIME);
        }

        commonArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

        console.log(`[streammp3] Strategy: ${strategy.name}`);
        console.log(`[streammp3] Starting yt-dlp for ${videoId}`);

        ytdlp = spawn('yt-dlp', commonArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        activeYtdlp = ytdlp;

        attachChildErrorHandler(ytdlp, `streammp3-${strategy.name}-ytdlp`);
        attachStreamErrorHandler(ytdlp.stdout, `streammp3-${strategy.name}-stdout`);
        attachStreamErrorHandler(ytdlp.stderr, `streammp3-${strategy.name}-stderr`);

        ytdlp.stderr.on('data', (data) => {
          const text = data.toString();
          ytdlpStderr += text;
          if (ytdlpStderr.length > 16000) ytdlpStderr = ytdlpStderr.slice(-16000);
          console.log(`[streammp3] yt-dlp: ${text.trim()}`);
        });

        // FFmpeg is started immediately, but the HTTP response is NOT committed
        // until actual MP3 bytes arrive. This prevents the old 200/empty-stream bug.
        ffmpeg = spawn('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'warning',
          '-i', 'pipe:0',
          '-vn',
          '-ac', '2',
          '-ar', '44100',
          '-b:a', '128k',
          '-codec:a', 'libmp3lame',
          '-f', 'mp3',
          'pipe:1'
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        activeFfmpeg = ffmpeg;
        ffmpegStarted = true;

        attachChildErrorHandler(ffmpeg, `streammp3-${strategy.name}-ffmpeg`);
        attachStreamErrorHandler(ffmpeg.stdin, `streammp3-${strategy.name}-ffmpeg-stdin`);
        attachStreamErrorHandler(ffmpeg.stdout, `streammp3-${strategy.name}-ffmpeg-stdout`);
        attachStreamErrorHandler(ffmpeg.stderr, `streammp3-${strategy.name}-ffmpeg-stderr`);

        ffmpeg.stderr.on('data', (data) => {
          const text = data.toString();
          ffmpegStderr += text;
          if (ffmpegStderr.length > 12000) ffmpegStderr = ffmpegStderr.slice(-12000);
          console.log(`[streammp3] FFmpeg: ${text.trim()}`);
        });

        ytdlp.stdout.on('data', (chunk) => {
          bytesFromYtdlp += chunk.length;

          if (clientDisconnected || settled || ffmpeg.stdin.destroyed || ffmpeg.stdin.writableEnded) {
            return;
          }

          try {
            const ok = ffmpeg.stdin.write(chunk);
            if (!ok) ytdlp.stdout.pause();
          } catch (err) {
            if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
              console.error('[streammp3] yt-dlp → FFmpeg error:', err.message);
            }
            finish({ ok: false, aborted: clientDisconnected, bytesFromYtdlp, bytesToClient, ytdlpStderr, ffmpegStderr });
          }
        });

        ffmpeg.stdin.on('drain', () => {
          if (!clientDisconnected && !settled && ytdlp && !ytdlp.stdout.destroyed) {
            ytdlp.stdout.resume();
          }
        });

        ytdlp.stdout.on('end', () => {
          console.log(`[streammp3] yt-dlp stdout ended: ${bytesFromYtdlp} bytes`);
          try {
            if (!ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) ffmpeg.stdin.end();
          } catch (_) {}
        });

        ffmpeg.stdout.on('data', (chunk) => {
          if (clientDisconnected || settled) return;

          bytesToClient += chunk.length;

          if (!outputStarted) {
            outputStarted = true;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Accept-Ranges', 'none');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('X-Stream-Backend', `yt-dlp-${strategy.name}-ffmpeg-mp3`);
            console.log(`[streammp3] MP3 output started: ${videoId}`);
          }

          try {
            if (!res.destroyed && res.writable) res.write(chunk);
          } catch (err) {
            if (!['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
              console.error('[streammp3] FFmpeg → client error:', err.message);
            }
            clientDisconnected = true;
            killActiveProcesses();
          }
        });

        ytdlp.on('close', (code) => {
          console.log(`[streammp3] yt-dlp exited with code ${code}`);
          if (code !== 0 && bytesFromYtdlp === 0) {
            console.error(`[streammp3] yt-dlp message: ${ytdlpStderr.trim()}`);
          }
        });

        ffmpeg.on('close', (code, signal) => {
          console.log(`[streammp3] FFmpeg exited with code ${code}${signal ? ` signal=${signal}` : ''}`);
          console.log(`[streammp3] Audio bytes: yt-dlp=${bytesFromYtdlp}, client=${bytesToClient}`);

          if (clientDisconnected) {
            return finish({ ok: false, aborted: true, bytesFromYtdlp, bytesToClient, ytdlpStderr, ffmpegStderr });
          }

          if (outputStarted && bytesToClient > 0 && code === 0) {
            responseFinished = true;
            try {
              if (!res.destroyed && !res.writableEnded) res.end();
            } catch (_) {}
            return finish({ ok: true, bytesFromYtdlp, bytesToClient });
          }

          finish({
            ok: false,
            bytesFromYtdlp,
            bytesToClient,
            ytdlpStderr,
            ffmpegStderr,
            ffmpegCode: code
          });
        });

        ytdlp.on('error', (err) => {
          if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
            console.error('[streammp3] yt-dlp process error:', err.message);
          }
          if (bytesFromYtdlp === 0) {
            finish({ ok: false, bytesFromYtdlp, bytesToClient, ytdlpStderr, ffmpegStderr });
          }
        });

        ffmpeg.on('error', (err) => {
          if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
            console.error('[streammp3] FFmpeg process error:', err.message);
          }
          finish({ ok: false, bytesFromYtdlp, bytesToClient, ytdlpStderr, ffmpegStderr });
        });
      });
    }

    for (const strategy of extractionStrategies) {
      if (clientDisconnected) return;

      const result = await runStrategy(strategy);

      if (result.ok || result.aborted) return;

      console.log(`[streammp3] Strategy failed: ${strategy.name}`);
    }

    if (!res.headersSent && !clientDisconnected) {
      const details = [
        'YouTube audio extraction failed.',
        'The PO-token provider/client may not be installed or reachable.',
        'Make sure bgutil-ytdlp-pot-provider is installed for yt-dlp and YOUTUBE_POT_PROVIDER_URL points to its HTTP server.',
        'Last yt-dlp output:',
        extractionStrategies.length ? 'See Railway logs for the individual strategy errors.' : ''
      ].join('\n');

      return res.status(502).json({
        error: 'YouTube audio extraction failed',
        details,
        poTokenProvider: YOUTUBE_POT_ENABLED,
        poTokenProviderUrl: YOUTUBE_POT_ENABLED ? YOUTUBE_POT_PROVIDER_URL : null,
        poTokenClient: YOUTUBE_POT_ENABLED ? YOUTUBE_POT_CLIENT : null
      });
    }
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
      engine: 'InnerTube + yt-dlp + PO-token provider + FFmpeg',
      poTokenProviderEnabled: YOUTUBE_POT_ENABLED,
      poTokenProviderUrl: YOUTUBE_POT_ENABLED ? YOUTUBE_POT_PROVIDER_URL : null,
      poTokenClient: YOUTUBE_POT_ENABLED ? YOUTUBE_POT_CLIENT : null,
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

<p>
PO-token provider: <b>${YOUTUBE_POT_ENABLED ? 'ENABLED' : 'DISABLED'}</b>
</p>

<p>
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
