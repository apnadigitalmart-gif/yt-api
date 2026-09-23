/**
 * YouTube Audio Streaming API Server
 * No API keys. No headless browser.
 *
 * Uses InnerTube API for metadata/search + yt-dlp for actual audio streaming.
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   GET  /api/search?q=...                 - Search YouTube
 *   GET  /api/video/:id                    - Get video info + audio streams
 *   GET  /api/stream/:id                   - Stream best audio directly
 *   GET  /api/stream/:id/:itag             - Stream specific format
 *   GET  /api/streammp3/:videoId           - Convert YouTube audio to MP3
 *   GET  /api/health                       - Health check
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

    proc.on('close', (code) => {

      resolve(code === 0);

    });

    proc.on('error', () => {

      resolve(false);

    });

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

    proc.on('close', (code) => {

      resolve(code === 0);

    });

    proc.on('error', () => {

      resolve(false);

    });

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

  // Check if yt-dlp is available

  const proc = spawn(
    'yt-dlp',
    ['--version'],
    {
      timeout: 3000
    }
  );

  proc.on('error', () => {

    if (!res.headersSent) {

      return res.status(500).json({
        error:
          'yt-dlp not found. Install it: pip install yt-dlp',
        hint:
          'brew install yt-dlp or pip3 install yt-dlp'
      });

    }

  });

  proc.on('close', (code) => {

    if (code !== 0) {

      if (!res.headersSent) {

        return res.status(500).json({
          error: 'yt-dlp not available'
        });

      }

      return;

    }


    // ──────────────────────────────────────────
    // yt-dlp is available
    // ──────────────────────────────────────────

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

      '--quiet',

      '--no-progress',

      ytUrl

    ];


    console.log(
      `  📡 yt-dlp ${args.join(' ')}`
    );


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


    // ──────────────────────────────────────────
    // Content type
    // ──────────────────────────────────────────

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


    // ──────────────────────────────────────────
    // Capture stderr
    // ──────────────────────────────────────────

    let stderr = '';

    ytProc.stderr.on(
      'data',
      (d) => {

        stderr += d.toString();

      }
    );


    // ──────────────────────────────────────────
    // Stream audio
    // ──────────────────────────────────────────

    ytProc.stdout.pipe(res);


    // ──────────────────────────────────────────
    // yt-dlp error
    // ──────────────────────────────────────────

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


    // ──────────────────────────────────────────
    // yt-dlp exit
    // ──────────────────────────────────────────

    ytProc.on(
      'close',
      (code) => {

        if (code !== 0 && !res.headersSent) {

          console.error(
            'yt-dlp stderr:',
            stderr.slice(0, 500)
          );

          streamFallback(
            res,
            videoIdOrUrl,
            itag
          );

        }

      }
    );


    // ──────────────────────────────────────────
    // Client disconnected
    // ──────────────────────────────────────────

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
// NEW MOMO-2 MP3 STREAMING ENDPOINT
//
// YouTube
//    ↓
// yt-dlp
//    ↓
// FFmpeg
//    ↓
// MP3 128 kbps
//    ↓
// HTTP
//    ↓
// MOMO-2 ESP32-S3
//
// GET /api/streammp3/:videoId
// ──────────────────────────────────────────────

app.get(
  '/api/streammp3/:videoId',
  async (req, res) => {

    const videoId =
      req.params.videoId;


    // ──────────────────────────────────────────
    // Validate YouTube video ID
    // ──────────────────────────────────────────

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

      // ────────────────────────────────────────
      // HTTP response headers
      // ────────────────────────────────────────

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
      // Start yt-dlp
      // ────────────────────────────────────────

      console.log(
        `[streammp3] Starting yt-dlp: ${videoId}`
      );


      ytdlp =
        spawn(
          'yt-dlp',
          [

            '--no-playlist',

            '--no-warnings',

            '--quiet',

            '--no-progress',

            '-f',
            'bestaudio/best',

            '-o',
            '-',

            youtubeUrl

          ],
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
      // Start FFmpeg
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

            // Read input from yt-dlp
            '-i',
            'pipe:0',

            // Audio only
            '-vn',

            // Stereo
            '-ac',
            '2',

            // Sample rate
            '-ar',
            '44100',

            // MP3 bitrate
            '-b:a',
            '128k',

            // MP3 encoder
            '-codec:a',
            'libmp3lame',

            // MP3 output
            '-f',
            'mp3',

            // Output to stdout
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
      // PIPE:
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


      // ────────────────────────────────────────
      // yt-dlp diagnostic buffer
      // ────────────────────────────────────────

      let ytdlpError = '';


      ytdlp.stderr.on(
        'data',
        (data) => {

          ytdlpError +=
            data.toString();

        }
      );


      // ────────────────────────────────────────
      // FFmpeg errors
      // ────────────────────────────────────────

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
                `[streammp3] yt-dlp message: ${ytdlpError.slice(0, 1000)}`
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
        '1.1.0',

      noApiKeyRequired:
        true,

      engine:
        'InnerTube + yt-dlp',

      ytdlpAvailable:
        hasYtdlp,

      ffmpegAvailable:
        hasFfmpeg,

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


  <!-- SEARCH -->

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


  <!-- VIDEO -->

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


  <!-- EXISTING STREAM -->

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


  <!-- ITAG STREAM -->

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


  <!-- MOMO MP3 -->

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
      Designed for MOMO-2 ESP32-S3
      MP3 playback.
    </p>

  </div>


  <!-- HEALTH -->

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
      Check yt-dlp and FFmpeg availability.
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
║   MOMO MP3:                                  ║
║   /api/streammp3/:videoId                    ║
║                                              ║
╚══════════════════════════════════════════════╝

    `);

  }
);
