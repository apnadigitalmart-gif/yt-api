/**
 * YouTube Audio Streaming API Server
 *
 * Version: 1.2.3
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

const VERSION = '1.2.3';

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

    console.log(`🎵 MOMO-2 MP3 STREAM: ${videoId}`);

    if (!isValidVideoId(videoId)) {
      return res.status(400).json({
        error: 'Invalid YouTube video ID'
      });
    }

    let ytdlp = null;
    let ffmpeg = null;

    let clientDisconnected = false;
    let responseStarted = false;
    let responseFinished = false;
    let terminalHandled = false;

    let bytesFromYtdlp = 0;
    let bytesToClient = 0;

    let ytdlpStderr = '';
    let ffmpegStderr = '';

    const pendingAudio = [];
    let pendingBytes = 0;

    const extractionStrategies = [
      {
        name: 'default',
        extractorArgs: null,
        cookieArgs: true
      },
      {
        name: 'web_embedded',
        extractorArgs: 'youtube:player_client=web_embedded',
        cookieArgs: false
      },
      {
        name: 'web_music',
        extractorArgs: 'youtube:player_client=web_music',
        cookieArgs: false
      },
      {
        name: 'web_embedded_default',
        extractorArgs: 'youtube:player_client=web_embedded,default',
        cookieArgs: true
      }
    ];

    const sendError = (status, message, details = '') => {
      if (clientDisconnected || responseStarted || res.headersSent || res.destroyed) {
        return false;
      }

      const body = {
        error: message
      };

      if (details) {
        body.details = details;
      }

      try {
        res.status(status).json(body);
        return true;
      } catch (err) {
        console.error('[streammp3] Error response failed:', err.message);
        return false;
      }
    };

    const startResponse = () => {
      if (responseStarted || clientDisconnected || res.destroyed) {
        return;
      }

      responseStarted = true;

      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('X-Stream-Backend', 'yt-dlp-ffmpeg-mp3');
      res.setHeader('X-Stream-Format', 'mp3-44100-stereo-128k');

      console.log(`[streammp3] Audio response started: ${videoId}`);

      for (const chunk of pendingAudio) {
        if (!res.destroyed && res.writable) {
          res.write(chunk);
          bytesToClient += chunk.length;
        }
      }

      pendingAudio.length = 0;
      pendingBytes = 0;
    };

    const terminateChildren = () => {
      if (ytdlp) safeKill(ytdlp);
      if (ffmpeg) safeKill(ffmpeg);
    };

    const cleanupClient = () => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      terminateChildren();
    };

    req.on('aborted', () => {
      console.log(`[streammp3] Client aborted: ${videoId}`);
      cleanupClient();
    });

    res.on('close', () => {
      if (!res.writableEnded && !responseFinished && !responseStarted) {
        console.log(`[streammp3] Client disconnected before audio started: ${videoId}`);
        cleanupClient();
      } else if (!res.writableEnded && !responseFinished && responseStarted) {
        console.log(`[streammp3] Client disconnected during audio: ${videoId}`);
        cleanupClient();
      }
    });

    res.on('error', (err) => {
      if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
        console.log(`[streammp3] Expected response error: ${err.code}`);
      } else {
        console.error('[streammp3] Response error:', err.message);
      }
      cleanupClient();
    });

    const runStrategy = (strategy) => new Promise((resolve) => {
      if (clientDisconnected || responseStarted) {
        resolve({ ok: false, reason: 'client-disconnected' });
        return;
      }

      bytesFromYtdlp = 0;
      ytdlpStderr = '';
      ffmpegStderr = '';
      pendingAudio.length = 0;
      pendingBytes = 0;

      const args = [
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--force-ipv4',
        '--no-check-certificates',
        '-f',
        'bestaudio/best',
        '-o',
        '-'
      ];

      if (strategy.extractorArgs) {
        args.push('--extractor-args', strategy.extractorArgs);
      }

      if (strategy.cookieArgs) {
        const cookieArgs = getYoutubeCookieArgs();
        if (cookieArgs.length) args.push(...cookieArgs);
      }

      args.push(`https://www.youtube.com/watch?v=${videoId}`);

      console.log(`[streammp3] Extraction strategy: ${strategy.name}`);
      console.log(`[streammp3] Starting yt-dlp: ${videoId}`);

      ytdlp = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      attachChildErrorHandler(ytdlp, `streammp3-ytdlp-${strategy.name}`);
      attachStreamErrorHandler(ytdlp.stdout, `streammp3-ytdlp-stdout-${strategy.name}`);
      attachStreamErrorHandler(ytdlp.stderr, `streammp3-ytdlp-stderr-${strategy.name}`);

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

      attachChildErrorHandler(ffmpeg, `streammp3-ffmpeg-${strategy.name}`);
      attachStreamErrorHandler(ffmpeg.stdin, `streammp3-ffmpeg-stdin-${strategy.name}`);
      attachStreamErrorHandler(ffmpeg.stdout, `streammp3-ffmpeg-stdout-${strategy.name}`);
      attachStreamErrorHandler(ffmpeg.stderr, `streammp3-ffmpeg-stderr-${strategy.name}`);

      let ytdlpClosed = false;
      let ffmpegClosed = false;
      let ytdlpCode = null;
      let ffmpegCode = null;
      let ffmpegSignal = null;
      let settled = false;
      let inputEnded = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      ytdlp.stderr.on('data', (data) => {
        const text = data.toString();
        ytdlpStderr += text;
        if (ytdlpStderr.length > 16000) ytdlpStderr = ytdlpStderr.slice(-16000);
        const clean = text.trim();
        if (clean) console.log(`[streammp3] yt-dlp: ${clean}`);
      });

      ffmpeg.stderr.on('data', (data) => {
        const text = data.toString();
        ffmpegStderr += text;
        if (ffmpegStderr.length > 12000) ffmpegStderr = ffmpegStderr.slice(-12000);
        const clean = text.trim();
        if (clean) console.log(`[streammp3] FFmpeg: ${clean}`);
      });

      ytdlp.stdout.on('data', (chunk) => {
        bytesFromYtdlp += chunk.length;

        if (clientDisconnected || ffmpeg.stdin.destroyed || ffmpeg.stdin.writableEnded) {
          return;
        }

        try {
          const canContinue = ffmpeg.stdin.write(chunk);
          if (!canContinue) {
            ytdlp.stdout.pause();
            ffmpeg.stdin.once('drain', () => {
              if (!clientDisconnected && !ffmpeg.stdin.destroyed) {
                ytdlp.stdout.resume();
              }
            });
          }
        } catch (err) {
          if (err && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
            console.log(`[streammp3] FFmpeg input closed: ${err.code}`);
          } else {
            console.error('[streammp3] yt-dlp → FFmpeg error:', err.message);
          }
        }
      });

      ytdlp.stdout.on('end', () => {
        console.log(`[streammp3] yt-dlp stdout ended: ${bytesFromYtdlp} bytes`);
        if (!inputEnded) {
          inputEnded = true;
          try {
            if (!ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) {
              ffmpeg.stdin.end();
            }
          } catch (err) {
            if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
              console.error('[streammp3] FFmpeg stdin end error:', err.message);
            }
          }
        }
      });

      ffmpeg.stdout.on('data', (chunk) => {
        if (clientDisconnected) return;

        if (!responseStarted) {
          pendingAudio.push(chunk);
          pendingBytes += chunk.length;
          startResponse();
          return;
        }

        try {
          if (!res.destroyed && res.writable) {
            res.write(chunk);
            bytesToClient += chunk.length;
          }
        } catch (err) {
          if (err && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code)) {
            console.log(`[streammp3] Client pipe closed: ${err.code}`);
            cleanupClient();
          } else {
            console.error('[streammp3] FFmpeg → client error:', err.message);
          }
        }
      });

      ytdlp.on('error', (err) => {
        if (err && !['EPIPE', 'ECONNRESET'].includes(err.code)) {
          console.error('[streammp3] yt-dlp process error:', err.message);
        }
      });

      ffmpeg.on('error', (err) => {
        if (err && !['EPIPE', 'ECONNRESET'].includes(err.code)) {
          console.error('[streammp3] FFmpeg process error:', err.message);
        }
      });

      ytdlp.on('close', (code) => {
        ytdlpClosed = true;
        ytdlpCode = code;
        console.log(`[streammp3] yt-dlp exited with code ${code}`);

        if (code !== 0 && bytesFromYtdlp === 0 && ytdlpStderr.trim()) {
          console.log(`[streammp3] yt-dlp message: ${ytdlpStderr.trim()}`);
        }

        if (ytdlpClosed && ffmpegClosed) {
          finish({
            ok: responseStarted && bytesToClient > 0,
            ytdlpCode,
            ffmpegCode,
            ffmpegSignal,
            bytesFromYtdlp,
            bytesToClient,
            ytdlpStderr,
            ffmpegStderr
          });
        }
      });

      ffmpeg.on('close', (code, signal) => {
        ffmpegClosed = true;
        ffmpegCode = code;
        ffmpegSignal = signal;

        console.log(`[streammp3] FFmpeg exited with code ${code}` + (signal ? ` signal=${signal}` : ''));
        console.log(`[streammp3] Audio bytes: yt-dlp=${bytesFromYtdlp}, client=${bytesToClient}`);

        if (ytdlpClosed && ffmpegClosed) {
          finish({
            ok: responseStarted && bytesToClient > 0 && code === 0,
            ytdlpCode,
            ffmpegCode,
            ffmpegSignal,
            bytesFromYtdlp,
            bytesToClient,
            ytdlpStderr,
            ffmpegStderr
          });
        }
      });

      // Safety timeout for a stuck extraction attempt.
      setTimeout(() => {
        if (!settled && !clientDisconnected) {
          console.log(`[streammp3] Strategy timeout: ${strategy.name}`);
          safeKill(ytdlp);
          safeKill(ffmpeg);
          finish({
            ok: false,
            ytdlpCode,
            ffmpegCode,
            ffmpegSignal,
            bytesFromYtdlp,
            bytesToClient,
            ytdlpStderr,
            ffmpegStderr,
            timeout: true
          });
        }
      }, 30000);
    });

    (async () => {
      for (const strategy of extractionStrategies) {
        if (clientDisconnected || responseStarted) return;

        const result = await runStrategy(strategy);

        if (clientDisconnected) return;

        if (result.ok) {
          responseFinished = true;
          if (!res.destroyed && !res.writableEnded) res.end();
          return;
        }

        // A strategy that produced no usable audio is safe to retry.
        // Do not send HTTP 200 unless FFmpeg actually produced MP3 bytes.
        if (responseStarted) {
          responseFinished = true;
          if (!res.destroyed && !res.writableEnded) res.end();
          return;
        }

        ytdlp = null;
        ffmpeg = null;
      }

      if (clientDisconnected || responseFinished) return;

      terminalHandled = true;

      const combined = `${ytdlpStderr}\n${ffmpegStderr}`.trim();
      const concise = combined.length > 12000
        ? combined.slice(-12000)
        : combined;

      console.error(`[streammp3] All extraction strategies failed for ${videoId}`);

      sendError(
        502,
        'YouTube audio extraction failed',
        concise || 'yt-dlp/FFmpeg produced no playable audio'
      );
    })().catch((err) => {
      if (clientDisconnected || terminalHandled) return;

      console.error('[streammp3] Route error:', err.message);
      sendError(502, 'YouTube audio extraction failed', err.message);
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
