import type { CompositionClip, CompositionDoc } from '@open-director/protocol';
import type { MediaProbeInfo } from './media.js';

interface StageClipSpec {
  id: string;
  trackIndex: number;
  trackMuted: boolean;
  kind: CompositionClip['kind'];
  src: string;
  inSec: number;
  outSec?: number;
  at: number;
  speed: number;
  volume: number;
  muted: boolean;
  size?: { width: number; height: number };
  rotate?: number;
  className?: string;
  box: CompositionClip['box'];
  visualStyle: Record<string, string>;
  overrides: CompositionClip['overrides'];
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  intrinsicDuration?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the deterministic multi-track HTML stage page (`/__film/stage.html`) from `composition.html`.
 */
export function buildStageHtml(
  doc: CompositionDoc,
  mediaInfo: ReadonlyMap<string, MediaProbeInfo>,
  totalDurationSec: number,
): string {
  const clips: StageClipSpec[] = [];
  for (let ti = 0; ti < doc.tracks.length; ti += 1) {
    const track = doc.tracks[ti];
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind === 'audio') continue;
      const info = mediaInfo.get(clip.src);
      clips.push({
        id: clip.id,
        trackIndex: ti,
        trackMuted: track.muted,
        kind: clip.kind,
        src: clip.src,
        inSec: clip.inSec,
        outSec: clip.outSec,
        at: clip.at,
        speed: clip.speed,
        volume: clip.volume,
        muted: clip.muted,
        size: clip.size,
        rotate: clip.rotate,
        className: clip.className,
        box: clip.box,
        visualStyle: clip.visualStyle,
        overrides: clip.overrides,
        intrinsicWidth: info?.width,
        intrinsicHeight: info?.height,
        intrinsicDuration: info?.durationSec,
      });
    }
  }

  const stageSpecJson = JSON.stringify({
    viewport: doc.viewport,
    trackCount: doc.tracks.length,
    totalDuration: totalDurationSec,
    clips,
  });

  const userStyles = doc.styles.map((css) => `<style>\n${css}\n</style>`).join('\n');
  const extraHead = doc.extraHeadHtml.join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="icon" href="data:,">
  <title>Open Director Stage</title>
  ${extraHead}
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${doc.viewport.width}px;
      height: ${doc.viewport.height}px;
      overflow: hidden;
      background: #000;
    }
    #od-stage {
      position: relative;
      width: ${doc.viewport.width}px;
      height: ${doc.viewport.height}px;
      overflow: hidden;
      background: #000;
    }
    .od-clip-wrap {
      position: absolute;
      overflow: hidden;
      display: none;
      transform-origin: center center;
    }
    .od-clip-wrap > iframe,
    .od-clip-wrap > video,
    .od-clip-wrap > img {
      display: block;
      border: 0;
    }
    .od-clip-wrap > video,
    .od-clip-wrap > img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  </style>
  ${userStyles}
</head>
<body>
  <div id="od-stage"></div>
  <script type="module">
    const STAGE = ${stageSpecJson};
    const stageEl = document.getElementById('od-stage');
    const mounted = [];

    function clipBaseOpacity(clip) {
      const raw = clip.visualStyle?.opacity;
      if (raw === undefined) return 1;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 1;
    }

    function computeFadeFactor(clip, localFilmTime, clipDur) {
      const fadeEntry = (clip.overrides || []).find((o) => o && 'fade' in o && !('at' in o));
      if (!fadeEntry || !Array.isArray(fadeEntry.fade)) return 1;
      const [fadeIn, fadeOut] = fadeEntry.fade;
      let factor = 1;
      if (fadeIn > 0 && localFilmTime < fadeIn) {
        factor = Math.min(factor, Math.max(0, localFilmTime / fadeIn));
      }
      if (fadeOut > 0 && Number.isFinite(clipDur)) {
        const rem = clipDur - localFilmTime;
        if (rem < fadeOut) {
          factor = Math.min(factor, Math.max(0, rem / fadeOut));
        }
      }
      return factor;
    }

    function applyVisualStyles(el, clip) {
      for (const [k, v] of Object.entries(clip.visualStyle || {})) {
        if (k === 'opacity') continue;
        el.style.setProperty(k, v);
      }
      if (typeof clip.rotate === 'number' && clip.rotate !== 0) {
        el.style.rotate = clip.rotate + 'deg';
      }
    }

    function layoutBox(wrap, clip, naturalW, naturalH) {
      const stageW = STAGE.viewport.width;
      const stageH = STAGE.viewport.height;
      let left = clip.box.left ?? 0;
      let top = clip.box.top ?? 0;
      let width = clip.box.width;
      let height = clip.box.height;

      if (width === undefined && height === undefined) {
        if (clip.kind === 'page') {
          width = naturalW ?? stageW;
          height = naturalH ?? stageH;
          if (clip.box.left === undefined) left = (stageW - width) / 2;
          if (clip.box.top === undefined) top = (stageH - height) / 2;
        } else {
          width = stageW;
          height = stageH;
        }
      } else if (width !== undefined && height === undefined) {
        const ratio = naturalW && naturalH ? naturalH / naturalW : stageH / stageW;
        height = Math.round(width * ratio);
      } else if (height !== undefined && width === undefined) {
        const ratio = naturalW && naturalH ? naturalW / naturalH : stageW / stageH;
        width = Math.round(height * ratio);
      }

      wrap.style.left = left + 'px';
      wrap.style.top = top + 'px';
      wrap.style.width = width + 'px';
      wrap.style.height = height + 'px';
      return { width, height };
    }

    async function waitForChildFilm(iframe) {
      const win = iframe.contentWindow;
      if (!win) throw new Error('Missing iframe contentWindow');
      const deadline = Date.now() + 10000;
      while (!win.film && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      if (!win.film) {
        throw new Error('Page "' + iframe.dataset.src + '" did not define window.film within 10s');
      }
      const ready = typeof win.film.ready === 'function' ? win.film.ready() : win.film.ready;
      if (ready) await Promise.resolve(ready);
      const frameFn = win.film.frame || win.film.renderAt || win.film.seek;
      if (typeof frameFn !== 'function') {
        throw new Error('Page "' + iframe.dataset.src + '" window.film has no frame(t) function');
      }
      return { win, film: win.film, frameFn: frameFn.bind(win.film) };
    }

    async function mountAll() {
      const promises = [];
      for (const clip of STAGE.clips) {
        const wrap = document.createElement('div');
        wrap.className = 'od-clip-wrap' + (clip.className ? ' ' + clip.className : '');
        wrap.dataset.clipId = clip.id;
        wrap.style.zIndex = String((STAGE.trackCount - clip.trackIndex) * 10);
        applyVisualStyles(wrap, clip);
        stageEl.appendChild(wrap);

        const item = {
          clip,
          wrap,
          baseOpacity: clipBaseOpacity(clip),
          child: null,
          video: null,
          img: null,
          duration: undefined,
        };
        mounted.push(item);

        if (clip.kind === 'page') {
          const iframe = document.createElement('iframe');
          iframe.dataset.src = clip.src;
          const sep = clip.src.includes('?') ? '&' : '?';
          iframe.src = '/' + clip.src.replace(/^\\/+/, '') + sep + '__film_host=1';
          iframe.scrolling = 'no';
          const initW = clip.size?.width ?? clip.box.width ?? STAGE.viewport.width;
          const initH = clip.size?.height ?? clip.box.height ?? STAGE.viewport.height;
          iframe.style.width = initW + 'px';
          iframe.style.height = initH + 'px';
          wrap.appendChild(iframe);

          promises.push(
            new Promise((resolve, reject) => {
              iframe.addEventListener('load', () => resolve(), { once: true });
              iframe.addEventListener('error', () => reject(new Error('Failed to load ' + clip.src)), { once: true });
            }).then(async () => {
              const child = await waitForChildFilm(iframe);
              item.child = child;
              const pageW = typeof child.film.width === 'number' ? child.film.width : (clip.size?.width ?? clip.box.width ?? STAGE.viewport.width);
              const pageH = typeof child.film.height === 'number' ? child.film.height : (clip.size?.height ?? clip.box.height ?? STAGE.viewport.height);
              iframe.style.width = pageW + 'px';
              iframe.style.height = pageH + 'px';
              const box = layoutBox(wrap, clip, pageW, pageH);
              const scale = Math.min(box.width / pageW, box.height / pageH);
              iframe.style.transformOrigin = 'top left';
              const offsetX = (box.width - pageW * scale) / 2;
              const offsetY = (box.height - pageH * scale) / 2;
              iframe.style.transform = 'translate(' + offsetX + 'px,' + offsetY + 'px) scale(' + scale + ')';
              const srcEnd = clip.outSec ?? (typeof child.film.duration === 'number' ? child.film.duration : undefined);
              item.duration = srcEnd !== undefined ? Math.max(0, srcEnd - clip.inSec) : undefined;
            }),
          );
        } else if (clip.kind === 'video') {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          video.src = '/' + clip.src.replace(/^\\/+/, '');
          if (clip.className) video.className = clip.className;
          applyVisualStyles(video, clip);
          wrap.appendChild(video);
          item.video = video;
          promises.push(
            new Promise((resolve, reject) => {
              if (video.readyState >= 1) return resolve();
              video.addEventListener('loadedmetadata', () => resolve(), { once: true });
              video.addEventListener('error', () => reject(new Error('Failed to load video ' + clip.src)), { once: true });
            }).then(() => {
              layoutBox(wrap, clip, video.videoWidth || clip.intrinsicWidth, video.videoHeight || clip.intrinsicHeight);
              const srcEnd = clip.outSec ?? (Number.isFinite(video.duration) ? video.duration : clip.intrinsicDuration);
              item.duration = srcEnd !== undefined ? Math.max(0, (srcEnd - clip.inSec) / clip.speed) : undefined;
            }),
          );
        } else if (clip.kind === 'image') {
          const img = document.createElement('img');
          img.src = '/' + clip.src.replace(/^\\/+/, '');
          if (clip.className) img.className = clip.className;
          applyVisualStyles(img, clip);
          wrap.appendChild(img);
          item.img = img;
          promises.push(
            img.decode().catch(() => {}).then(() => {
              layoutBox(wrap, clip, img.naturalWidth, img.naturalHeight);
              item.duration = clip.outSec !== undefined ? Math.max(0, clip.outSec - clip.inSec) : undefined;
            }),
          );
        }
      }
      if (document.fonts?.ready) {
        promises.push(document.fonts.ready.catch(() => {}));
      }
      await Promise.all(promises);
    }

    const readyPromise = mountAll();

    function seekVideo(video, targetSec) {
      if (!Number.isFinite(targetSec)) return Promise.resolve();
      const clamped = Math.max(0, Math.min(video.duration || targetSec, targetSec));
      if (Math.abs(video.currentTime - clamped) <= 0.0005 && video.readyState >= 2) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        video.addEventListener(
          'seeked',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        video.currentTime = clamped;
      });
    }

    async function renderAtTime(T) {
      await readyPromise;
      const tasks = [];
      for (const item of mounted) {
        const { clip, wrap } = item;
        const dur = item.duration ?? Infinity;
        const localFilm = T - clip.at;
        const active = localFilm >= -1e-6 && localFilm < dur - 1e-6;
        if (!active) {
          wrap.style.display = 'none';
          continue;
        }
        wrap.style.display = 'block';
        const fade = computeFadeFactor(clip, Math.max(0, localFilm), dur);
        wrap.style.opacity = String(item.baseOpacity * fade);

        if (item.child) {
          const { win, film, frameFn } = item.child;
          let localT = clip.inSec + Math.max(0, localFilm);
          if (typeof film.duration === 'number' && localT > film.duration) {
            localT = film.duration;
          }
          tasks.push(
            (async () => {
              const rootOnly = (clip.overrides || []).filter((o) => o && o.at === ':root');
              if (win.filmHost && rootOnly.length > 0) win.filmHost.applyOverrides(rootOnly);
              if (win.filmHost) win.filmHost.time(localT);
              await Promise.resolve(frameFn(localT));
              if (win.filmHost && (clip.overrides || []).length > 0) win.filmHost.applyOverrides(clip.overrides);
              if (win.filmHost) win.filmHost.settle(localT);
            })(),
          );
        } else if (item.video) {
          const targetVideoSec = clip.inSec + Math.max(0, localFilm) * clip.speed;
          tasks.push(seekVideo(item.video, targetVideoSec));
        }
      }
      await Promise.all(tasks);
    }

    function inspectCurrentWarnings() {
      const samples = [];
      const overflows = [];
      for (const item of mounted) {
        if (item.wrap.style.display === 'none' || !item.child) continue;
        const doc = item.child.win.document;
        for (const el of doc.querySelectorAll('[data-film-sample]')) {
          const cs = item.child.win.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && rect.width >= 2 && rect.height >= 2) {
            samples.push({
              clipId: item.clip.id,
              hint: el.getAttribute('data-film-sample') || 'sample',
            });
          }
        }
        for (const el of doc.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          const text = (el.textContent || '').trim();
          if (!text) continue;
          const cs = item.child.win.getComputedStyle(el);
          if (Number(cs.opacity) < 0.35 || cs.visibility === 'hidden') continue;
          const parent = el.parentElement;
          const clipsParent = parent && item.child.win.getComputedStyle(parent).overflow !== 'visible';
          const clipsSelf = cs.overflow !== 'visible';
          if ((clipsSelf || clipsParent) && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)) {
            overflows.push({ clipId: item.clip.id, text: text.slice(0, 40) });
          }
        }
      }
      return { samples, overflows };
    }

    function getSfxEvents() {
      const events = [];
      for (const item of mounted) {
        if (item.clip.trackMuted || !item.child) continue;
        const list = item.child.film?.sfx;
        if (!Array.isArray(list)) continue;
        for (const sfx of list.slice(0, 200)) {
          if (!sfx || typeof sfx.at !== 'number') continue;
          if (sfx.at < item.clip.inSec) continue;
          if (item.duration !== undefined && sfx.at >= item.clip.inSec + item.duration) continue;
          const filmSec = item.clip.at + (sfx.at - item.clip.inSec);
          events.push({
            clipId: item.clip.id,
            pageSrc: item.clip.src,
            filmSec,
            id: typeof sfx.id === 'string' ? sfx.id : undefined,
            src: typeof sfx.src === 'string' ? sfx.src : undefined,
            gain: typeof sfx.gain === 'number' ? sfx.gain : 0,
            pan: typeof sfx.pan === 'number' ? sfx.pan : 0,
            label: typeof sfx.label === 'string' ? sfx.label : undefined,
          });
        }
      }
      return events;
    }

    window.film = {
      duration: STAGE.totalDuration,
      ready: readyPromise,
      frame: renderAtTime,
    };
    window.__openDirectorStage = {
      ready: readyPromise,
      renderAtTime,
      inspectCurrentWarnings,
      getSfxEvents,
    };

    readyPromise.then(() => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { source: 'open-director-stage', type: 'ready', duration: STAGE.totalDuration },
          '*',
        );
      }
    }).catch((err) => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { source: 'open-director-stage', type: 'error', message: err?.message ?? String(err) },
          '*',
        );
      }
    });

    window.addEventListener('message', async (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object' || msg.source !== 'open-director-studio') return;
      if (msg.type === 'seek' && typeof msg.t === 'number') {
        await renderAtTime(msg.t);
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ source: 'open-director-stage', type: 'seeked', t: msg.t }, '*');
        }
      }
    });

    // If opened directly in a browser tab (not inside Studio or headless filmHost), self-fit and loop play
    if (window.parent === window && !window.filmHost) {
      const fitToWindow = () => {
        const s = Math.min(window.innerWidth / STAGE.viewport.width, window.innerHeight / STAGE.viewport.height, 1);
        document.documentElement.style.width = '100%';
        document.documentElement.style.height = '100%';
        document.body.style.width = '100%';
        document.body.style.height = '100%';
        document.body.style.display = 'grid';
        document.body.style.placeItems = 'center';
        stageEl.style.transformOrigin = 'center center';
        stageEl.style.transform = 'scale(' + s + ')';
      };
      fitToWindow();
      window.addEventListener('resize', fitToWindow);
      readyPromise.then(() => {
        const t0 = performance.now();
        const dur = STAGE.totalDuration > 0 ? STAGE.totalDuration : 4;
        const loop = async () => {
          const elapsed = ((performance.now() - t0) / 1000) % dur;
          await renderAtTime(elapsed);
          requestAnimationFrame(() => { void loop(); });
        };
        void loop();
      });
    }
  </script>
</body>
</html>
`;
}

export function buildStandalonePageHtmlPlaceholder(title: string): string {
  return escapeHtml(title);
}
