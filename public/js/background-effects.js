(function () {
  'use strict';
  // Background blur for your camera (Teams-style, roadmap 2.9), used by the call panel
  // (group-calls.js) and the meeting page (meet-room.js). Runs entirely in your browser: MediaPipe's
  // selfie segmenter (public/js/vendor/mediapipe) finds you in each frame, and the rest of the frame
  // is blurred before the video is sent — the server and other people only ever get the result.
  //
  //   NovaBackground.mode() / setMode('none' | 'blur')  your choice, remembered on this device
  //   await NovaBackground.process(cameraTrack)          -> { track, stop() }: the track to show and
  //                                                        send (the camera itself when blur is off)
  //
  // Frames are processed with the browser's "breakout box" (MediaStreamTrackProcessor/Generator:
  // Chrome, Edge, the desktop apps), which keeps running while the tab is in the background; other
  // browsers use a canvas, which pauses while the tab is hidden.
  const BASE = '/js/vendor/mediapipe';
  const KEY = 'nc.background';
  const WORK_W = 640, WORK_H = 360; // segmentation and blur run at this size; output keeps the camera's

  let segmenterReady = null;
  function loadSegmenter() {
    segmenterReady ??= (async () => {
      const { ImageSegmenter, FilesetResolver } = await import(BASE + '/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(BASE + '/wasm');
      const options = delegate => ({
        baseOptions: { modelAssetPath: BASE + '/selfie_segmenter.tflite', delegate },
        runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
      });
      try { return await ImageSegmenter.createFromOptions(fileset, options('GPU')); }
      catch { return await ImageSegmenter.createFromOptions(fileset, options('CPU')); }
    })();
    segmenterReady.catch(() => { segmenterReady = null; }); // allow a later retry
    return segmenterReady;
  }

  const canvasOf = (w, h) => {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    return c;
  };
  const filterWorks = (() => { try { const g = canvasOf(1, 1).getContext('2d'); return 'filter' in g; } catch { return false; } })();

  // Draws one blurred-background frame of `source` (a video element or VideoFrame) into `out`:
  // the frame blurred, then the frame at full sharpness wherever the segmenter sees a person.
  function makeCompositor() {
    const small = canvasOf(WORK_W, WORK_H), sg = small.getContext('2d');
    const mask = canvasOf(WORK_W, WORK_H), mg = mask.getContext('2d');
    const tiny = canvasOf(48, 27), tg = tiny.getContext('2d'); // blur without ctx.filter: shrink, enlarge
    const maskData = mg.createImageData(WORK_W, WORK_H);
    let sharp = null, shg = null, haveMask = false, lastTs = 0;
    return async function compose(source, out, og) {
      const segmenter = await loadSegmenter();
      const W = out.width, H = out.height;
      if (!sharp || sharp.width !== W || sharp.height !== H) { sharp = canvasOf(W, H); shg = sharp.getContext('2d'); }
      sg.drawImage(source, 0, 0, WORK_W, WORK_H);
      let ts = performance.now(); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
      // The mask is only valid inside the callback: copy it into the alpha of maskData there.
      segmenter.segmentForVideo(small, ts, result => {
        const m = result.confidenceMasks?.[0];
        if (m) {
          const conf = m.getAsFloat32Array(), d = maskData.data;
          for (let i = 0, a = 3; i < conf.length; i++, a += 4) d[a] = conf[i] * 255;
          haveMask = true;
        }
        result.confidenceMasks?.forEach(x => x.close());
      });
      // Background: the frame, blurred (never shown unblurred, even before the first mask).
      og.save();
      if (filterWorks) { og.filter = 'blur(' + Math.max(8, Math.round(W / 90)) + 'px)'; og.drawImage(small, -16, -16, W + 32, H + 32); }
      else { tg.drawImage(small, 0, 0, tiny.width, tiny.height); og.imageSmoothingQuality = 'high'; og.drawImage(tiny, 0, 0, W, H); }
      og.restore();
      if (!haveMask) return;
      mg.putImageData(maskData, 0, 0);
      // You: the source at full size, cut out by the (smoothly enlarged) mask.
      shg.globalCompositeOperation = 'copy'; shg.drawImage(source, 0, 0, W, H);
      shg.globalCompositeOperation = 'destination-in'; shg.imageSmoothingQuality = 'high'; shg.drawImage(mask, 0, 0, W, H);
      og.drawImage(sharp, 0, 0);
    };
  }

  async function blurTrack(camera) {
    await loadSegmenter(); // fail here (not per frame) if the model can't load
    const settings = camera.getSettings();
    const W = settings.width || 1280, H = settings.height || 720;
    const compose = makeCompositor();
    let stopped = false;

    // Chrome / Edge / Electron: frame by frame, also while the tab is in the background.
    if (typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function') {
      const processor = new MediaStreamTrackProcessor({ track: camera });
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const out = canvasOf(W, H), og = out.getContext('2d');
      const reader = processor.readable.getReader(), writer = generator.writable.getWriter();
      (async () => {
        while (!stopped) {
          const { value: frame, done } = await reader.read();
          if (done || stopped) { frame?.close(); break; }
          try {
            if (out.width !== frame.displayWidth || out.height !== frame.displayHeight) { out.width = frame.displayWidth; out.height = frame.displayHeight; }
            await compose(frame, out, og);
            const next = new VideoFrame(out, { timestamp: frame.timestamp });
            await writer.write(next);
          } catch { /* skip a frame */ } finally { frame.close(); }
        }
        try { reader.releaseLock(); writer.releaseLock(); } catch { /* closed */ }
      })();
      generator.contentHint = 'motion';
      return { track: generator, stop() { stopped = true; generator.stop(); } };
    }

    // Other browsers: a playing video element drawn into a canvas stream.
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([camera]);
    await video.play().catch(() => {});
    const out = Object.assign(document.createElement('canvas'), { width: W, height: H }), og = out.getContext('2d');
    const track = out.captureStream(settings.frameRate || 24).getVideoTracks()[0];
    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= 2) { try { await compose(video, out, og); } catch { /* skip */ } }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    tick();
    return { track, stop() { stopped = true; track.stop(); video.srcObject = null; } };
  }

  const read = () => { try { return localStorage.getItem(KEY) === 'blur' ? 'blur' : 'none'; } catch { return 'none'; } };
  window.NovaBackground = {
    // WebAssembly and a 2D canvas are the minimum; the model itself loads on first use.
    available: typeof WebAssembly === 'object' && typeof HTMLCanvasElement === 'function',
    mode: read,
    setMode(mode) { try { localStorage.setItem(KEY, mode === 'blur' ? 'blur' : 'none'); } catch { /* not remembered */ } },
    // The track to show and send for this camera: blurred when blur is chosen (and works here).
    async process(camera, mode = read()) {
      if (!camera || camera.kind !== 'video' || mode !== 'blur' || !this.available) return { track: camera, stop() {}, mode: 'none' };
      try { const r = await blurTrack(camera); return { ...r, mode: 'blur' }; }
      catch (e) { console.warn('Background blur unavailable:', e?.message || e); return { track: camera, stop() {}, mode: 'none', error: e }; }
    },
  };
})();
