"""Minimal demo HTML page served at GET / by `mediakit video serve`.

A single static page with no build step and no frameworks - just enough to
demonstrate that the server is wired and a video plays in the browser. The
"real" SPA tab lands as a follow-up layer; this page is intentionally throwaway.
"""

DEMO_HTML = """\
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mediakit demo</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      max-width: 1000px;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #ddd;
      background: #111;
    }
    h1 { font-weight: 500; margin-bottom: 0.2rem; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
    select {
      width: 100%;
      padding: 0.6rem;
      font-size: 1rem;
      background: #1c1c1c;
      color: #ddd;
      border: 1px solid #333;
      border-radius: 4px;
      margin-bottom: 1rem;
    }
    select:focus { outline: 1px solid #888; }
    video {
      width: 100%;
      max-height: 70vh;
      background: #000;
      border-radius: 4px;
    }
    .status {
      color: #888;
      font-size: 0.85rem;
      margin-top: 0.5rem;
      min-height: 1.2rem;
    }
    code {
      background: #1c1c1c;
      padding: 0.1em 0.4em;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .footnote { color: #666; font-size: 0.8rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>mediakit</h1>
  <p class="meta" id="caps">connecting...</p>
  <select id="picker" disabled>
    <option>loading...</option>
  </select>
  <video id="player" controls preload="metadata"></video>
  <p class="status" id="status"></p>
  <p class="footnote">
    Raw bytes: <code>GET /api/videos/&lt;id&gt;/stream</code> (Range supported, no transcode).
    Browser playback: <code>GET /api/videos/&lt;id&gt;/play</code> (ffmpeg remux + AAC audio re-encode).
  </p>
  <script>
  (async () => {
    const $caps = document.getElementById('caps');
    const $picker = document.getElementById('picker');
    const $player = document.getElementById('player');
    const $status = document.getElementById('status');

    function setStatus(msg) { $status.textContent = msg; }

    try {
      const caps = await fetch('/capabilities').then(r => r.json());
      const filesWord = caps.video_count === 1 ? 'file' : 'files';
      const audioWord = caps.audio ? 'on' : 'off';
      $caps.textContent =
        `${caps.server} v${caps.version}  -  audio: ${audioWord}  -  video: ${caps.video_count} ${filesWord}`;

      const videos = await fetch('/api/videos').then(r => r.json());
      $picker.innerHTML = '';
      if (videos.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(no videos found under <root>/videos/)';
        $picker.appendChild(opt);
        return;
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'pick a video...';
      $picker.appendChild(placeholder);
      for (const v of videos) {
        const opt = document.createElement('option');
        opt.value = v.id;
        const sizeGb = (v.size_bytes / 1e9).toFixed(2);
        opt.textContent = `${v.name}  (${sizeGb} GB)`;
        $picker.appendChild(opt);
      }
      $picker.disabled = false;

      $picker.addEventListener('change', (e) => {
        const id = e.target.value;
        if (!id) {
          $player.removeAttribute('src');
          setStatus('');
          return;
        }
        const url = `/api/videos/${encodeURIComponent(id)}/play`;
        setStatus(`loading ${url} (server is transcoding on the fly)...`);
        $player.src = url;
        $player.play().catch(err => setStatus('autoplay blocked: ' + err.message));
      });

      $player.addEventListener('playing', () => setStatus('playing'));
      $player.addEventListener('error', () => {
        const err = $player.error;
        setStatus(err ? `playback error (code ${err.code})` : 'playback error');
      });
    } catch (err) {
      $caps.textContent = 'error: ' + err.message;
    }
  })();
  </script>
</body>
</html>
"""
