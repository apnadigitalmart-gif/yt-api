/**
 * YouTube Audio Streaming API Server
 * No API keys. No headless browser.
 *
 * Uses InnerTube API for metadata/search + yt-dlp for actual audio streaming.
 *
 * MOMO-2 YouTube MP3 support:
 * YouTube
 *   ↓
 * yt-dlp + optional YouTube cookies
 *   ↓
 * FFmpeg
 *   ↓
 * MP3 128 kbps / 44.1 kHz
 *   ↓
 * MOMO-2 ESP32-S3
 *
 * Endpoints:
 *   GET  /api/search?q=...
 *   GET  /api/video/:id
 *   GET  /api/stream/:id
 *   GET  /api/stream/:id/:itag
 *   GET  /api/streammp3/:videoId
 *   GET  /api/health
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


// ──────────────────────────────────────────────
// YouTube cookies
//
// Railway Variable:
//   YOUTUBE_COOKIES
//
// The value must contain the complete Netscape-format
// cookies.txt content.
//
// IMPORTANT:
// Cookie contents are NEVER printed to logs.
// ──────────────────────────────────────────────

const YOUTUBE_COOKIE_FILE =
  path.join(
    os.tmpdir(),
    'youtube-cookies.txt'
  );


function prepareYoutubeCookies() {

  if (!process.env.YOUTUBE_COOKIES) {

    console.log(
      '[cookies] YOUTUBE_COOKIES not configured'
    );

    return false;

  }


  try {

    fs.writeFileSync(
      YOUTUBE_COOKIE_FILE,
      process.env.YOUTUBE_COOKIES,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );


    console.log(
      '[cookies] YouTube cookies loaded securely'
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

  if (
    process.env.YOUTUBE_COOKIES &&
    fs.existsSync(YOUTUBE_COOKIE_FILE)
  ) {

    return [
      '--cookies',
      YOUTUBE_COOKIE_FILE
    ];

  }


  return [];

}


// Prepare cookies when server starts.
const youtubeCookiesConfigured =
  prepareYoutubeCookies();


// ──────────────────────────────────────────────
// CORS + JSON + static files
// ──────────────────────────────────────────────

app.use(express.static(__dirname));
app.use(express.json());


app.use((req, res, next) => {

  res.header(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Range'
  );

  if (req.method === 'OPTIONS') {

    return res.sendStatus(200);

  }

  next();

});


// ──────────────────────────────────────────────
// Check if yt-dlp is available
// ──────────────────────────────────────────────

function checkYtdlp() {

  return new Promise((resolve) => {

    const proc = spawn(
      'yt-dlp',
      ['--version'],
      {
        timeout: 5000
      }
    );

    proc.on(
      'close',
      (code) => {

        resolve(code === 0);

      }
    );

    proc.on(
      'error',
      () => {

        resolve(false);

      }
    );

  });

}


// ──────────────────────────────────────────────
// Check if FFmpeg is available
// ──────────────────────────────────────────────

function checkFfmpeg() {

  return new Promise((resolve) => {

    const proc = spawn(
      'ffmpeg',
      ['-version'],
      {
        timeout: 5000
      }
    );

    proc.on(
      'close',
      (code) => {

        resolve(code === 0);

      }
    );

    proc.on(
      'error',
      () => {

        resolve(false);

      }
    );

  });

}


// ──────────────────────────────────────────────
// Existing YouTube audio streaming
// yt-dlp backend
// ──────────────────────────────────────────────

function streamViaYtdlp(
  res,
  videoIdOrUrl,
  itag
) {

  const proc = spawn(
    'yt-dlp',
    ['--version'],
    {
      timeout: 3000
    }
  );


  proc.on(
    'error',
    () => {

      if (!res.headersSent) {

        return res.status(500).json({

          error:
            'yt-dlp not found. Install it: pip install yt-dlp',

          hint:
            'brew install yt-dlp or pip3 install yt-dlp'

        });

      }

    }
  );


  proc.on(
    'close',
    (code) => {

      if (code !== 0) {

        if (!res.headersSent) {

          return res.status(500).json({

            error:
              'yt-dlp not available'

          });

        }

        return;

      }


      const ytUrl =
        videoIdOrUrl.includes('youtube.com') ||
        videoIdOrUrl.includes('youtu.be')
          ? videoIdOrUrl
          : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;


      const args = [

        '-f',

        itag
          ? String(itag)
          : '140/251/250/249/139/bestaudio',

        '-o',
        '-',

        '--no-playlist',

        '--no-warnings',

        '--verbose',

        '--no-progress',

        ...getYoutubeCookieArgs(),

        ytUrl

      ];


      console.log(
        `  📡 yt-dlp streaming: ${videoIdOrUrl}`
      );


      if (
        process.env.YOUTUBE_COOKIES
      ) {

        console.log(
          '  🍪 yt-dlp YouTube cookies: ENABLED'
        );

      }


      const ytProc = spawn(
        'yt-dlp',
        args,
        {
          stdio: [
            'ignore',
            'pipe',
            'pipe'
          ],
          timeout: 0
        }
      );


      const ext =
        itag === 251 ||
        itag === 250 ||
        itag === 249
          ? 'audio/webm'
          : 'audio/mp4';


      res.setHeader(
        'Content-Type',
        ext
      );

      res.setHeader(
        'Cache-Control',
        'no-cache'
      );

      res.setHeader(
        'X-Stream-Backend',
        'yt-dlp'
      );


      let stderr = '';


      ytProc.stderr.on(
        'data',
        (d) => {

          stderr += d.toString();

        }
      );


      ytProc.stdout.pipe(res);


      ytProc.on(
        'error',
        (err) => {

          console.error(
            'yt-dlp error:',
            err.message
          );


          if (!res.headersSent) {

            streamFallback(
              res,
              videoIdOrUrl,
              itag
            );

          }

        }
      );


      ytProc.on(
        'close',
        (code) => {

          if (code !== 0 && !res.headersSent) {

            console.error(
              'yt-dlp stderr:',
              stderr.slice(0, 1000)
            );


            streamFallback(
              res,
              videoIdOrUrl,
              itag
            );

          }

        }
      );


      res.on(
        'close',
        () => {

          if (!ytProc.killed) {

            try {

              ytProc.kill(
                'SIGKILL'
              );

            } catch (_) {}

          }

        }
      );

    });

}


// ──────────────────────────────────────────────
// Fallback:
// Stream directly from InnerTube URL
// ──────────────────────────────────────────────

async function streamFallback(
  res,
  videoIdOrUrl,
  itag
) {

  try {

    const {
      getAudioStream
    } = require('./lib/innerTube');


    const videoId =
      extractVideoId(videoIdOrUrl) ||
      videoIdOrUrl;


    const audio =
      await getAudioStream(
        videoId,
        itag || undefined
      );


    if (!audio || !audio.url) {

      return res.status(500).json({

        error:
          'No stream URL available'

      });

    }


    console.log(
      `  📡 Fallback InnerTube stream: itag=${audio.itag || itag}`
    );


    const https =
      require('https');


    const u =
      new URL(audio.url);


    const fetchReq =
      https.request(
        {
          hostname:
            u.hostname,

          port:
            443,

          path:
            u.pathname +
            u.search,

          method:
            'GET',

          headers: {

            'User-Agent':
              'com.google.android.youtube/20.10.38'

          }

        },

        (fetchRes) => {

          res.setHeader(
            'Content-Type',
            audio.mimeType?.split(';')[0] ||
              'audio/mp4'
          );


          res.setHeader(
            'X-Stream-Backend',
            'innertube-fallback'
          );


          fetchRes.pipe(res);

        }
      );


    fetchReq.on(
      'error',
      (err) => {

        if (!res.headersSent) {

          res.status(502).json({

            error:
              err.message

          });

        }

      }
    );


    fetchReq.end();


  } catch (err) {

    if (!res.headersSent) {

      res.status(500).json({

        error:
          err.message

      });

    }

  }

}


// ──────────────────────────────────────────────
// MOMO-2 MP3 STREAMING ENDPOINT
//
// GET /api/streammp3/:videoId
//
// YouTube
//    ↓
// yt-dlp
//    ↓
// FFmpeg
//    ↓
// MP3 128 kbps / 44.1 kHz
//    ↓
// HTTP
//    ↓
// MOMO-2 ESP32-S3
// ──────────────────────────────────────────────

app.get(
  '/api/streammp3/:videoId',
  async (req, res) => {

    const videoId =
      req.params.videoId;


    if (
      !/^[a-zA-Z0-9_-]{11}$/.test(
        videoId
      )
    ) {

      return res.status(400).json({

        error:
          'Invalid YouTube video ID'

      });

    }


    const youtubeUrl =
      `https://www.youtube.com/watch?v=${videoId}`;


    console.log(
      `\n🎵 MOMO-2 MP3 STREAM: ${videoId}`
    );


    let ytdlp = null;
    let ffmpeg = null;


    try {

      res.statusCode = 200;


      res.setHeader(
        'Content-Type',
        'audio/mpeg'
      );


      res.setHeader(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );


      res.setHeader(
        'Pragma',
        'no-cache'
      );


      res.setHeader(
        'Accept-Ranges',
        'none'
      );


      res.setHeader(
        'Transfer-Encoding',
        'chunked'
      );


      res.setHeader(
        'X-Stream-Backend',
        'yt-dlp-ffmpeg-mp3'
      );


      // ────────────────────────────────────────
      // yt-dlp arguments
      // ────────────────────────────────────────

      const ytdlpArgs = [

        '--no-playlist',

        '--no-warnings',

        '--verbose',

        '--no-progress',

        '-f',
        'bestaudio/best',

        ...getYoutubeCookieArgs(),

        '-o',
        '-',

        youtubeUrl

      ];


      console.log(
        `[streammp3] Starting yt-dlp: ${videoId}`
      );


      if (
        process.env.YOUTUBE_COOKIES
      ) {

        console.log(
          '[streammp3] YouTube cookies: ENABLED'
        );

      } else {

        console.log(
          '[streammp3] YouTube cookies: NOT CONFIGURED'
        );

      }


      ytdlp =
        spawn(
          'yt-dlp',
          ytdlpArgs,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ],
            timeout: 0
          }
        );


      // ────────────────────────────────────────
      // FFmpeg
      // ────────────────────────────────────────

      console.log(
        `[streammp3] Starting FFmpeg: ${videoId}`
      );


      ffmpeg =
        spawn(
          'ffmpeg',
          [

            '-hide_banner',

            '-loglevel',
            'error',

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

          ],
          {
            stdio: [
              'pipe',
              'pipe',
              'pipe'
            ],
            timeout: 0
          }
        );


      // ────────────────────────────────────────
      // PIPE
      //
      // yt-dlp stdout
      //       ↓
      // FFmpeg stdin
      //       ↓
      // FFmpeg stdout
      //       ↓
      // HTTP response
      // ────────────────────────────────────────

      ytdlp.stdout.pipe(
        ffmpeg.stdin
      );


      ffmpeg.stdout.pipe(
        res
      );


      let ytdlpError = '';


      ytdlp.stderr.on(
        'data',
        (data) => {

          ytdlpError +=
            data.toString();

        }
      );


      ffmpeg.stderr.on(
        'data',
        (data) => {

          console.error(
            `[streammp3] FFmpeg: ${data.toString()}`
          );

        }
      );


      // ────────────────────────────────────────
      // yt-dlp process error
      // ────────────────────────────────────────

      ytdlp.on(
        'error',
        (error) => {

          console.error(
            '[streammp3] yt-dlp error:',
            error.message
          );


          if (!res.headersSent) {

            res.status(500).json({

              error:
                'yt-dlp failed',

              details:
                error.message

            });

          }


          if (ffmpeg) {

            try {

              ffmpeg.kill(
                'SIGKILL'
              );

            } catch (_) {}

          }

        }
      );


      // ────────────────────────────────────────
      // FFmpeg process error
      // ────────────────────────────────────────

      ffmpeg.on(
        'error',
        (error) => {

          console.error(
            '[streammp3] FFmpeg error:',
            error.message
          );


          if (!res.headersSent) {

            res.status(500).json({

              error:
                'FFmpeg failed',

              details:
                error.message

            });

          }


          if (ytdlp) {

            try {

              ytdlp.kill(
                'SIGKILL'
              );

            } catch (_) {}

          }

        }
      );


      // ────────────────────────────────────────
      // yt-dlp finished
      // ────────────────────────────────────────

      ytdlp.on(
        'close',
        (code) => {

          if (code !== 0) {

            console.error(
              `[streammp3] yt-dlp exited with code ${code}`
            );


            if (ytdlpError) {

              console.error(
                `[streammp3] yt-dlp message: ${ytdlpError.slice(0, 1500)}`
              );

            }

          } else {

            console.log(
              `[streammp3] yt-dlp finished: ${videoId}`
            );

          }

        }
      );


      // ────────────────────────────────────────
      // FFmpeg finished
      // ────────────────────────────────────────

      ffmpeg.on(
        'close',
        (code) => {

          console.log(
            `[streammp3] FFmpeg exited with code ${code}`
          );


          if (
            !res.writableEnded
          ) {

            res.end();

          }

        }
      );


      // ────────────────────────────────────────
      // Client disconnected
      // ────────────────────────────────────────

      req.on(
        'close',
        () => {

          console.log(
            `[streammp3] Client disconnected: ${videoId}`
          );


          if (
            ytdlp &&
            !ytdlp.killed
          ) {

            try {

              ytdlp.kill(
                'SIGKILL'
              );

            } catch (_) {}

          }


          if (
            ffmpeg &&
            !ffmpeg.killed
          ) {

            try {

              ffmpeg.kill(
                'SIGKILL'
              );

            } catch (_) {}

          }

        }
      );


    } catch (error) {

      console.error(
        '[streammp3] Unexpected error:',
        error
      );


      if (!res.headersSent) {

        res.status(500).json({

          error:
            'MP3 streaming failed',

          details:
            error.message

        });

      }


      if (
        ytdlp &&
        !ytdlp.killed
      ) {

        try {

          ytdlp.kill(
            'SIGKILL'
          );

        } catch (_) {}

      }


      if (
        ffmpeg &&
        !ffmpeg.killed
      ) {

        try {

          ffmpeg.kill(
            'SIGKILL'
          );

        } catch (_) {}

      }

    }

  }
);


// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

/**
 * GET /api/search?q=<query>&limit=10&type=music
 */

app.get(
  '/api/search',
  async (req, res) => {

    try {

      const {
        q,
        limit = 10,
        type
      } = req.query;


      if (!q) {

        return res.status(400).json({

          error:
            'Missing query parameter ?q='

        });

      }


      const results =
        type === 'music'
          ? await searchMusic(
              q,
              parseInt(limit)
            )
          : await search(
              q,
              parseInt(limit)
            );


      res.json({

        query: q,

        results

      });


    } catch (err) {

      console.error(
        'Search error:',
        err
      );


      res.status(500).json({

        error:
          err.message

      });

    }

  }
);


/**
 * GET /api/video/:id
 * Metadata + audio streams
 */

app.get(
  '/api/video/:id',
  async (req, res) => {

    try {

      const info =
        await getVideoInfo(
          req.params.id
        );


      const {
        playerResponse,
        ...cleanInfo
      } = info;


      res.json(
        cleanInfo
      );


    } catch (err) {

      console.error(
        'Video info error:',
        err
      );


      res.status(500).json({

        error:
          err.message

      });

    }

  }
);


/**
 * GET /api/stream/:id[/:itag]
 * Existing direct audio stream
 */

app.get(
  '/api/stream/:id/:itag?',
  async (req, res) => {

    const videoId =
      extractVideoId(
        req.params.id
      ) ||
      req.params.id;


    const itag =
      req.params.itag
        ? parseInt(
            req.params.itag
          )
        : null;


    console.log(
      `\n🎧 Stream request: ${videoId}${itag ? ` (itag=${itag})` : ''}`
    );


    streamViaYtdlp(
      res,
      videoId,
      itag
    );

  }
);


// ──────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────

app.get(
  '/api/health',
  async (req, res) => {

    const hasYtdlp =
      await checkYtdlp();


    const hasFfmpeg =
      await checkFfmpeg();


    res.json({

      status:
        'ok',

      service:
        'YouTube Audio API',

      version:
        '1.2.0',

      noApiKeyRequired:
        true,

      engine:
        'InnerTube + yt-dlp + FFmpeg',

      ytdlpAvailable:
        hasYtdlp,

      ffmpegAvailable:
        hasFfmpeg,

      youtubeCookiesConfigured:
        !!process.env.YOUTUBE_COOKIES,

      momoMp3Endpoint:
        '/api/streammp3/:videoId'

    });

  }
);


// ──────────────────────────────────────────────
// Documentation page
// ──────────────────────────────────────────────

app.get(
  '/',
  (req, res) => {

    res.send(`

<!DOCTYPE html>

<html>

<head>

  <title>
    🎵 YouTube Audio Streaming API
  </title>

  <meta charset="utf-8">

  <style>

    * {
      box-sizing: border-box;
    }

    body {
      font-family: system-ui, sans-serif;
      max-width: 820px;
      margin: 40px auto;
      padding: 0 20px;
      background: #0f0f0f;
      color: #e0e0e0;
    }

    h1 {
      color: #ff4444;
    }

    code {
      background: #1a1a1a;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }

    pre {
      background: #1a1a1a;
      padding: 14px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 13px;
    }

    .endpoint {
      background: #1a1a1a;
      padding: 14px;
      border-radius: 8px;
      margin: 10px 0;
      border-left: 3px solid #ff4444;
    }

    .momo {
      background: #182018;
      border-left: 3px solid #4caf50;
    }

    .method {
      color: #4caf50;
      font-weight: bold;
    }

    a {
      color: #64b5f6;
    }

    table {
      border-collapse: collapse;
      width: 100%;
    }

    th,
    td {
      text-align: left;
      padding: 8px;
    }

    th {
      border-bottom: 1px solid #444;
    }

    td {
      border-bottom: 1px solid #222;
    }

  </style>

</head>


<body>


  <h1>
    🎵 YouTube Audio Streaming API
  </h1>


  <p>
    YouTube metadata/search + yt-dlp audio streaming.
  </p>


  <p>
    Powered by
    <strong>InnerTube</strong>
    +
    <strong>yt-dlp</strong>
    +
    <strong>FFmpeg</strong>
  </p>


  <div class="endpoint">

    <p>

      <span class="method">
        GET
      </span>

      <code>
        /api/search?q=chill+lofi&limit=5
      </code>

    </p>

    <p>
      Search YouTube.
      Add
      <code>&type=music</code>
      for music results.
    </p>

  </div>


  <div class="endpoint">

    <p>

      <span class="method">
        GET
      </span>

      <code>
        /api/video/dQw4w9WgXcQ
      </code>

    </p>

    <p>
      Get video metadata + available audio streams.
    </p>

  </div>


  <div class="endpoint">

    <p>

      <span class="method">
        GET
      </span>

      <code>
        /api/stream/dQw4w9WgXcQ
      </code>

    </p>

    <p>
      Stream best available audio directly.
    </p>

  </div>


  <div class="endpoint">

    <p>

      <span class="method">
        GET
      </span>

      <code>
        /api/stream/dQw4w9WgXcQ/140
      </code>

    </p>

    <p>
      Stream a specific YouTube audio format.
    </p>

  </div>


  <div class="endpoint momo">

    <h2>
      🤖 MOMO-2 MP3 Streaming
    </h2>


    <p>

      <span class="method">
        GET
      </span>

      <code>
        /api/streammp3/dQw4w9WgXcQ
      </code>

    </p>


    <p>
      Converts YouTube audio to
      <strong>MP3 128 kbps / 44.1 kHz</strong>
      using yt-dlp + FFmpeg.
    </p>


    <p>
      YouTube cookies are supported through the
      Railway
      <code>YOUTUBE_COOKIES</code>
      variable.
    </p>


    <p>
      Designed for MOMO-2 ESP32-S3
      MP3 playback.
    </p>

  </div>


  <div class="endpoint">

    <p>

      <span class="method">
        GET
      </span>

      <code>
        /api/health
      </code>

    </p>

    <p>
      Check yt-dlp, FFmpeg and YouTube-cookie configuration.
    </p>

  </div>


  <h2>
    Examples
  </h2>


  <pre>

# Search music

curl "http://localhost:${PORT}/api/search?q=Tum+Hi+Ho&limit=5&type=music"


# Get video information

curl "http://localhost:${PORT}/api/video/Umqb9KENgmk"


# Existing direct audio

curl "http://localhost:${PORT}/api/stream/Umqb9KENgmk/140" -o song.m4a


# MOMO-2 MP3 stream

curl "http://localhost:${PORT}/api/streammp3/Umqb9KENgmk" -o momo-test.mp3


# Health

curl "http://localhost:${PORT}/api/health"

  </pre>


  <h2>
    Audio Formats
  </h2>


  <table>

    <tr>
      <th>itag</th>
      <th>Codec</th>
      <th>Quality</th>
      <th>Container</th>
    </tr>

    <tr>
      <td>251</td>
      <td>Opus</td>
      <td>~160 kbps</td>
      <td>webm</td>
    </tr>

    <tr>
      <td>140</td>
      <td>AAC LC</td>
      <td>128 kbps</td>
      <td>m4a</td>
    </tr>

    <tr>
      <td>250</td>
      <td>Opus</td>
      <td>~70 kbps</td>
      <td>webm</td>
    </tr>

    <tr>
      <td>249</td>
      <td>Opus</td>
      <td>~50 kbps</td>
      <td>webm</td>
    </tr>

    <tr>
      <td>139</td>
      <td>AAC HE</td>
      <td>48 kbps</td>
      <td>m4a</td>
    </tr>

  </table>


  <p
    style="
      margin-top: 40px;
      color: #555;
      font-size: 12px;
    "
  >

    <strong>
      Requirements:
    </strong>

    <code>
      yt-dlp
    </code>

    +

    <code>
      FFmpeg
    </code>

    <br>

    Built with YouTube InnerTube,
    yt-dlp and FFmpeg.

  </p>


</body>

</html>

    `);

  }
);


// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────

app.listen(
  PORT,
  () => {

    console.log(`

╔══════════════════════════════════════════════╗
║   🎵 YouTube Audio Streaming API            ║
║                                              ║
║   InnerTube + yt-dlp + FFmpeg                ║
║                                              ║
║   Server: http://localhost:${PORT}
║   Health: /api/health                        ║
║                                              ║
║   YouTube Cookies: ${youtubeCookiesConfigured ? 'ENABLED ' : 'DISABLED'}             ║
║                                              ║
║   MOMO MP3:                                  ║
║   /api/streammp3/:videoId                    ║
║                                              ║
╚══════════════════════════════════════════════╝

    `);

  }
);
