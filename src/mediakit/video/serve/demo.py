"""Minimal demo HTML page served at GET / by `mediakit video serve`.

Uses HLS (via hls.js loaded from a CDN for browsers without native HLS) so
the player gets seek + a real timeline as ffmpeg produces segments. Shows
ffprobe-derived duration upfront in the picker so users see total length
before pressing play.

A single static page with no build step. The "real" SPA tab lands as a
follow-up layer; this page is intentionally throwaway.
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
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
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
    Playing via HLS (<code>GET /api/videos/&lt;id&gt;/hls/index.m3u8</code>) - ffmpeg transcodes
    on demand into fMP4 segments and writes the playlist incrementally. The player gains seek
    + total-time as more segments materialise; when ffmpeg finishes the playlist gets
    <code>#EXT-X-ENDLIST</code> and the timeline becomes final.
    Other endpoints: <code>/api/videos/&lt;id&gt;/stream</code> (raw bytes, Range) and
    <code>/api/videos/&lt;id&gt;/play</code> (one-shot fMP4 - no seek, no duration).
  </p>
  <script>
  (function () {
    const $caps = document.getElementById('caps');
    const $picker = document.getElementById('picker');
    const $player = document.getElementById('player');
    const $status = document.getElementById('status');
    let activeHls = null;

    function setStatus(msg) { $status.textContent = msg; }

    function formatDuration(seconds) {
      if (seconds == null || !isFinite(seconds)) return '?:??';
      const total = Math.round(seconds);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      return m + ':' + String(s).padStart(2, '0');
    }

    function formatSize(bytes) {
      const gb = bytes / 1e9;
      if (gb >= 1) return gb.toFixed(2) + ' GB';
      return (bytes / 1e6).toFixed(1) + ' MB';
    }

    function loadVideo(id) {
      if (activeHls) { activeHls.destroy(); activeHls = null; }
      $player.removeAttribute('src');
      const url = '/api/videos/' + encodeURIComponent(id) + '/hls/index.m3u8';
      setStatus('starting hls transcode...');
      if ($player.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari plays HLS natively.
        $player.src = url;
        $player.play().catch(err => setStatus('autoplay blocked: ' + err.message));
        return;
      }
      if (!window.Hls || !window.Hls.isSupported()) {
        setStatus('hls.js failed to load - try Safari (native HLS) or check network.');
        return;
      }
      const hls = new window.Hls();
      hls.loadSource(url);
      hls.attachMedia($player);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        $player.play().catch(err => setStatus('autoplay blocked: ' + err.message));
      });
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) setStatus('hls error: ' + (data.details || data.type));
      });
      activeHls = hls;
    }

    (async function init() {
      try {
        const caps = await fetch('/capabilities').then(r => r.json());
        const filesWord = caps.video_count === 1 ? 'file' : 'files';
        const audioWord = caps.audio ? 'on' : 'off';
        $caps.textContent =
          caps.server + ' v' + caps.version + '  -  audio: ' + audioWord +
          '  -  video: ' + caps.video_count + ' ' + filesWord;

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
          const duration = formatDuration(v.duration_s);
          const size = formatSize(v.size_bytes);
          opt.textContent = v.name + '  -  ' + duration + '  (' + size + ')';
          $picker.appendChild(opt);
        }
        $picker.disabled = false;

        $picker.addEventListener('change', (e) => {
          const id = e.target.value;
          if (!id) {
            if (activeHls) { activeHls.destroy(); activeHls = null; }
            $player.removeAttribute('src');
            setStatus('');
            return;
          }
          loadVideo(id);
        });

        $player.addEventListener('playing', () => setStatus('playing'));
      } catch (err) {
        $caps.textContent = 'error: ' + err.message;
      }
    })();
  })();
  </script>
</body>
</html>
"""
