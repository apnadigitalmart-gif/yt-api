
app.get(
  '/api/streammp3/:videoId',
  async (req, res) => {
    const videoId = String(
      req.params.videoId || ''
    ).trim();

    console.log(
      `[streammp3] MOMO request: ${videoId}`
    );

    if (!isValidVideoId(videoId)) {
      return res.status(400).json({
        error: 'Invalid YouTube video ID'
      });
    }

    let ytdlp = null;
    let ffmpeg = null;

    let clientDisconnected = false;
    let cleanupDone = false;
    let responseStarted = false;
    let responseFinished = false;

    let bytesFromYtdlp = 0;
    let bytesToClient = 0;

    let ytdlpExitCode = null;
    let ffmpegExitCode = null;

    let ytdlpStderr = '';
    let ffmpegStderr = '';

    let ffmpegHasAudio = false;
    let ffmpegEnded = false;
    let ytdlpEnded = false;

    let pendingAudio = [];

    const MAX_INITIAL_BUFFER = 64 * 1024;

    const cleanup = () => {
      if (cleanupDone) return;

      cleanupDone = true;

      console.log(
        `[streammp3] Cleaning up: ${videoId}`
      );

      if (ytdlp) {
        safeKill(ytdlp);
      }

      if (ffmpeg) {
        safeKill(ffmpeg);
      }
    };

    const disconnectClient = () => {
      if (clientDisconnected) return;

      clientDisconnected = true;
      cleanup();
    };

    const sendJsonError = (
      status,
      error,
      details = ''
    ) => {
      if (
        responseStarted ||
        res.headersSent ||
        res.destroyed
      ) {
        return;
      }

      responseStarted = true;

      const body = {
        error
      };

      if (details) {
        body.details = details.slice(-4000);
      }

      res.status(status).json(body);
    };

    const startResponse = () => {
      if (
        responseStarted ||
        clientDisconnected ||
        res.destroyed
      ) {
        return;
      }

      responseStarted = true;

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
        'X-Stream-Backend',
        'yt-dlp-ffmpeg-mp3'
      );

      console.log(
        `[streammp3] Audio response started: ${videoId}`
      );

      for (const chunk of pendingAudio) {
        if (
          !res.destroyed &&
          res.writable
        ) {
          res.write(chunk);
        }
      }

      pendingAudio = [];
    };

    const writeAudio = (chunk) => {
      if (
        clientDisconnected ||
        cleanupDone ||
        !chunk ||
        !chunk.length
      ) {
        return;
      }

      if (!responseStarted) {
        pendingAudio.push(chunk);

        const bufferedBytes =
          pendingAudio.reduce(
            (total, item) => total + item.length,
            0
          );

        if (
          bufferedBytes >= MAX_INITIAL_BUFFER ||
          ffmpegHasAudio
        ) {
          startResponse();
        }

        return;
      }

      if (
        !res.destroyed &&
        res.writable
      ) {
        bytesToClient += chunk.length;

        const canContinue = res.write(chunk);

        if (!canContinue) {
          if (
            ffmpeg &&
            ffmpeg.stdout &&
            !ffmpeg.stdout.destroyed
          ) {
            ffmpeg.stdout.pause();

            res.once(
              'drain',
              () => {
                if (
                  !clientDisconnected &&
                  !cleanupDone &&
                  ffmpeg &&
                  ffmpeg.stdout &&
                  !ffmpeg.stdout.destroyed
                ) {
                  ffmpeg.stdout.resume();
                }
              }
            );
          }
        }
      }
    };

    req.on('aborted', () => {
      console.log(
        `[streammp3] Client aborted: ${videoId}`
      );

      disconnectClient();
    });

    res.on('close', () => {
      if (
        !res.writableEnded &&
        !responseFinished &&
        !clientDisconnected
      ) {
        console.log(
          `[streammp3] Client disconnected: ${videoId}`
        );

        disconnectClient();
      }
    });

    res.on('error', (err) => {
      console.error(
        `[streammp3] Response error: ${err.message}`
      );

      disconnectClient();
    });

    // --------------------------------------------------------
    // START YT-DLP
    // --------------------------------------------------------

    const cookieArgs =
      getYoutubeCookieArgs();

    const ytArgs = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--force-ipv4',
      '-f',
      'bestaudio/best',
      '-o',
      '-'
    ];

    if (cookieArgs.length) {
      ytArgs.push(...cookieArgs);
    }

    ytArgs.push(
      `https://www.youtube.com/watch?v=${videoId}`
    );

    console.log(
      `[streammp3] Starting yt-dlp: ${videoId}`
    );

    ytdlp = spawn(
      'yt-dlp',
      ytArgs,
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    attachChildErrorHandler(
      ytdlp,
      'streammp3-ytdlp'
    );

    attachStreamErrorHandler(
      ytdlp.stdout,
      'streammp3-ytdlp-stdout'
    );

    attachStreamErrorHandler(
      ytdlp.stderr,
      'streammp3-ytdlp-stderr'
    );

    ytdlp.stderr.on(
      'data',
      (data) => {
        const text = data.toString();

        ytdlpStderr += text;

        if (ytdlpStderr.length > 16000) {
          ytdlpStderr =
            ytdlpStderr.slice(-16000);
        }

        console.log(
          `[streammp3] yt-dlp: ${text.trim()}`
        );
      }
    );

    // --------------------------------------------------------
    // START FFMPEG
    // --------------------------------------------------------

    console.log(
      `[streammp3] Starting FFmpeg: ${videoId}`
    );

    ffmpeg = spawn(
      'ffmpeg',
      [
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
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'pipe'
        ]
      }
    );

    attachChildErrorHandler(
      ffmpeg,
      'streammp3-ffmpeg'
    );

    attachStreamErrorHandler(
      ffmpeg.stdin,
      'streammp3-ffmpeg-stdin'
    );

    attachStreamErrorHandler(
      ffmpeg.stdout,
      'streammp3-ffmpeg-stdout'
    );

    attachStreamErrorHandler(
      ffmpeg.stderr,
      'streammp3-ffmpeg-stderr'
    );

    ffmpeg.stderr.on(
      'data',
      (data) => {
        const text = data.toString();

        ffmpegStderr += text;

        if (ffmpegStderr.length > 12000) {
          ffmpegStderr =
            ffmpegStderr.slice(-12000);
        }

        console.log(
          `[streammp3] FFmpeg: ${text.trim()}`
        );
      }
    );

    // --------------------------------------------------------
    // YT-DLP → FFMPEG
    // --------------------------------------------------------

    ytdlp.stdout.on(
      'data',
      (chunk) => {
        bytesFromYtdlp += chunk.length;

        if (
          clientDisconnected ||
          cleanupDone ||
          !ffmpeg ||
          ffmpeg.stdin.destroyed ||
          ffmpeg.stdin.writableEnded
        ) {
          return;
        }

        try {
          const canContinue =
            ffmpeg.stdin.write(chunk);

          if (!canContinue) {
            ytdlp.stdout.pause();

            ffmpeg.stdin.once(
              'drain',
              () => {
                if (
                  !clientDisconnected &&
                  !cleanupDone &&
                  ytdlp &&
                  ytdlp.stdout &&
                  !ytdlp.stdout.destroyed
                ) {
                  ytdlp.stdout.resume();
                }
              }
            );
          }
        } catch (err) {
          console.error(
            '[streammp3] yt-dlp → FFmpeg error:',
            err.message
          );

          cleanup();
        }
      }
    );

    ytdlp.stdout.on(
      'end',
      () => {
        ytdlpEnded = true;

        console.log(
          `[streammp3] yt-dlp stdout ended: ${bytesFromYtdlp} bytes`
        );

        if (
          ffmpeg &&
          !ffmpeg.stdin.destroyed &&
          !ffmpeg.stdin.writableEnded
        ) {
          try {
            ffmpeg.stdin.end();
          } catch (err) {
            console.error(
              '[streammp3] FFmpeg stdin end error:',
              err.message
            );
          }
        }
      }
    );

    ytdlp.stdout.on(
      'error',
      (err) => {
        console.error(
          '[streammp3] yt-dlp stdout error:',
          err.message
        );
      }
    );

    // --------------------------------------------------------
    // FFMPEG → CLIENT
    // --------------------------------------------------------

    ffmpeg.stdout.on(
      'data',
      (chunk) => {
        if (
          clientDisconnected ||
          cleanupDone ||
          !chunk ||
          !chunk.length
        ) {
          return;
        }

        ffmpegHasAudio = true;

        startResponse();

        writeAudio(chunk);
      }
    );

    ffmpeg.stdout.on(
      'end',
      () => {
        ffmpegEnded = true;

        console.log(
          `[streammp3] FFmpeg stdout ended`
        );
      }
    );

    ffmpeg.stdout.on(
      'error',
      (err) => {
        console.error(
          '[streammp3] FFmpeg stdout error:',
          err.message
        );
      }
    );

    // --------------------------------------------------------
    // YT-DLP EXIT
    // --------------------------------------------------------

    ytdlp.on(
      'close',
      (code) => {
        ytdlpExitCode = code;

        console.log(
          `[streammp3] yt-dlp exited with code ${code}`
        );

        if (
          code !== 0 &&
          !clientDisconnected
        ) {
          console.error(
            `[streammp3] yt-dlp message: ${ytdlpStderr.trim()}`
          );

          if (
            !ffmpegHasAudio &&
            !responseStarted
          ) {
            sendJsonError(
              502,
              'YouTube audio extraction failed',
              ytdlpStderr.trim()
            );

            cleanup();
          }
        }
      }
    );

    // --------------------------------------------------------
    // FFMPEG EXIT
    // --------------------------------------------------------

    ffmpeg.on(
      'close',
      (code, signal) => {
        ffmpegExitCode = code;

        console.log(
          `[streammp3] FFmpeg exited with code ${code}` +
          (signal
            ? ` signal=${signal}`
            : '')
        );

        console.log(
          `[streammp3] Audio bytes: yt-dlp=${bytesFromYtdlp}, client=${bytesToClient}`
        );

        if (
          clientDisconnected ||
          cleanupDone
        ) {
          return;
        }

        if (
          !ffmpegHasAudio ||
          bytesToClient === 0
        ) {
          sendJsonError(
            502,
            'No playable audio received',
            [
              ytdlpStderr.trim(),
              ffmpegStderr.trim()
            ]
              .filter(Boolean)
              .join('\n')
          );

          cleanup();
          return;
        }

        responseFinished = true;

        if (
          !res.destroyed &&
          !res.writableEnded
        ) {
          res.end();
        }

        cleanupDone = true;
      }
    );

    // --------------------------------------------------------
    // PROCESS ERRORS
    // --------------------------------------------------------

    ytdlp.on(
      'error',
      (err) => {
        console.error(
          '[streammp3] yt-dlp process error:',
          err.message
        );

        if (!responseStarted) {
          sendJsonError(
            502,
            'yt-dlp process failed',
            err.message
          );
        }

        cleanup();
      }
    );

    ffmpeg.on(
      'error',
      (err) => {
        console.error(
          '[streammp3] FFmpeg process error:',
          err.message
        );

        if (!responseStarted) {
          sendJsonError(
            502,
            'FFmpeg process failed',
            err.message
          );
        }

        cleanup();
      }
    );
  }
);
