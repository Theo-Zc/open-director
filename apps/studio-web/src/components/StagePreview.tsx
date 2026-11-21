import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { CompositionClip, ProjectSnapshot } from '../types';

interface StagePreviewProps {
  snapshot: ProjectSnapshot;
  currentTime: number;
  playing: boolean;
  selectedClip: CompositionClip | null;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onEdit: (ops: Array<Record<string, unknown>>, why: string) => Promise<void>;
  reloadKey: number;
}

function formatClock(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(2).padStart(5, '0')}`;
}

export function StagePreview({
  snapshot,
  currentTime,
  playing,
  selectedClip,
  onTogglePlay,
  onSeek,
  onEdit,
  reloadKey,
}: StagePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const firedSfxRef = useRef<Set<string>>(new Set());
  const prevTimeRef = useRef(0);
  const [stageReady, setStageReady] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 720, height: 420 });
  const [boxDraft, setBoxDraft] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const { width: stageW, height: stageH } = snapshot.doc.viewport;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: Math.max(200, entry.contentRect.width - 24),
          height: Math.max(150, entry.contentRect.height - 24),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = Math.min(containerSize.width / stageW, containerSize.height / stageH, 1);

  useEffect(() => {
    setStageReady(false);
  }, [reloadKey, snapshot.filmOrigin]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object' || msg.source !== 'open-director-stage') return;
      if (msg.type === 'ready') {
        setStageReady(true);
        iframeRef.current?.contentWindow?.postMessage(
          { source: 'open-director-studio', type: 'seek', t: currentTime },
          '*',
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [currentTime]);

  useEffect(() => {
    if (!stageReady) return;
    iframeRef.current?.contentWindow?.postMessage(
      { source: 'open-director-studio', type: 'seek', t: currentTime },
      '*',
    );
  }, [currentTime, stageReady]);

  // Audible audio/video clips
  const audibleClips = useMemo(() => {
    const list: Array<{ id: string; src: string; at: number; inSec: number; outSec: number; speed: number; volume: number }> = [];
    for (const track of snapshot.doc.tracks) {
      if (track.hidden || track.muted) continue;
      for (const clip of track.clips) {
        if ((clip.kind !== 'audio' && clip.kind !== 'video') || clip.muted || clip.volume <= 0) continue;
        const info = snapshot.mediaInfo[clip.src];
        if (!info?.hasAudio) continue;
        const outSec = clip.outSec ?? info.durationSec;
        list.push({ id: clip.id, src: clip.src, at: clip.at, inSec: clip.inSec, outSec, speed: clip.speed, volume: clip.volume });
      }
    }
    return list;
  }, [snapshot]);

  // Page film.sfx events mapped onto timeline seconds
  const pageSfxSchedule = useMemo(() => {
    const list: Array<{ key: string; filmSec: number; url: string; gainDb: number }> = [];
    for (const track of snapshot.doc.tracks) {
      if (track.hidden || track.muted) continue;
      for (const clip of track.clips) {
        if (clip.kind !== 'page') continue;
        const meta = snapshot.pageMeta[clip.src];
        if (!meta?.sfx) continue;
        const clipDur = clip.outSec !== undefined ? clip.outSec - clip.inSec : meta.duration;
        for (let idx = 0; idx < meta.sfx.length; idx += 1) {
          const s = meta.sfx[idx];
          if (typeof s.at !== 'number' || s.at < clip.inSec) continue;
          if (clipDur !== undefined && s.at >= clip.inSec + clipDur) continue;
          const url = s.id
            ? `${snapshot.filmOrigin}/__film/sfx/${encodeURIComponent(s.id)}.wav`
            : s.src
              ? `${snapshot.filmOrigin}/${s.src.replace(/^\/+/, '')}`
              : '';
          if (!url) continue;
          list.push({
            key: `${clip.id}:${idx}:${s.at}`,
            filmSec: clip.at + (s.at - clip.inSec),
            url,
            gainDb: s.gain ?? 0,
          });
        }
      }
    }
    return list;
  }, [snapshot]);

  useEffect(() => {
    if (!playing) {
      firedSfxRef.current.clear();
      prevTimeRef.current = currentTime;
      return;
    }
    const prev = prevTimeRef.current;
    for (const ev of pageSfxSchedule) {
      if (ev.filmSec >= prev && ev.filmSec <= currentTime + 0.04 && !firedSfxRef.current.has(ev.key)) {
        firedSfxRef.current.add(ev.key);
        const audio = new Audio(ev.url);
        audio.volume = Math.min(1, Math.max(0, Math.pow(10, ev.gainDb / 20)));
        void audio.play().catch(() => {});
      }
    }
    prevTimeRef.current = currentTime;
  }, [playing, currentTime, pageSfxSchedule]);

  useEffect(() => {
    const map = audioElsRef.current;
    const validIds = new Set(audibleClips.map((c) => c.id));
    for (const [id, el] of map.entries()) {
      if (!validIds.has(id)) {
        el.pause();
        map.delete(id);
      }
    }
    for (const c of audibleClips) {
      let el = map.get(c.id);
      const url = `${snapshot.filmOrigin}/${c.src.replace(/^\/+/, '')}`;
      if (!el || el.src !== url) {
        el = new Audio(url);
        el.preload = 'auto';
        map.set(c.id, el);
      }
      el.volume = Math.min(1, Math.max(0, c.volume));
      el.playbackRate = c.speed;
    }
  }, [audibleClips, snapshot.filmOrigin]);

  useEffect(() => {
    for (const c of audibleClips) {
      const el = audioElsRef.current.get(c.id);
      if (!el) continue;
      const dur = (c.outSec - c.inSec) / c.speed;
      const active = currentTime >= c.at && currentTime < c.at + dur;
      if (!playing || !active) {
        if (!el.paused) el.pause();
        continue;
      }
      const target = c.inSec + (currentTime - c.at) * c.speed;
      if (Math.abs(el.currentTime - target) > 0.15) {
        el.currentTime = target;
      }
      if (el.paused) {
        void el.play().catch(() => {});
      }
    }
  }, [playing, currentTime, audibleClips]);

  const activeSubtitles = useMemo(
    () => snapshot.subtitles.filter((s) => currentTime >= s.startSec && currentTime <= s.endSec),
    [snapshot.subtitles, currentTime],
  );

  // Interactive box gizmo for the selected visual clip when active at currentTime
  const activeBox = useMemo(() => {
    if (!selectedClip || selectedClip.kind === 'audio') return null;
    const media = snapshot.mediaInfo[selectedClip.src];
    const page = snapshot.pageMeta[selectedClip.src];
    const srcEnd = selectedClip.outSec ?? media?.durationSec ?? page?.duration;
    const dur = srcEnd !== undefined ? (srcEnd - selectedClip.inSec) / (selectedClip.speed || 1) : Infinity;
    if (currentTime < selectedClip.at || currentTime >= selectedClip.at + dur) return null;
    return boxDraft ?? {
      left: selectedClip.box.left ?? 0,
      top: selectedClip.box.top ?? 0,
      width: selectedClip.box.width ?? stageW,
      height: selectedClip.box.height ?? stageH,
    };
  }, [selectedClip, snapshot, currentTime, boxDraft, stageW, stageH]);

  const startBoxInteraction = (mode: 'move' | 'resize', startClientX: number, startClientY: number) => {
    if (!selectedClip || !activeBox) return;
    const initial = { ...activeBox };
    let latest = { ...initial };
    const onMove = (ev: MouseEvent) => {
      const dx = Math.round((ev.clientX - startClientX) / scale);
      const dy = Math.round((ev.clientY - startClientY) / scale);
      latest =
        mode === 'move'
          ? { ...initial, left: initial.left + dx, top: initial.top + dy }
          : { ...initial, width: Math.max(40, initial.width + dx), height: Math.max(40, initial.height + dy) };
      setBoxDraft(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setBoxDraft(null);
      if (
        latest.left !== initial.left ||
        latest.top !== initial.top ||
        latest.width !== initial.width ||
        latest.height !== initial.height
      ) {
        void onEdit(
          [{ op: 'box', clip: selectedClip.id, left: latest.left, top: latest.top, width: latest.width, height: latest.height }],
          `画布拖拽调整 ${selectedClip.id} 位置尺寸`,
        );
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="stage-panel">
      <div className="stage-viewport-wrap" ref={containerRef}>
        <div
          className="stage-frame-box"
          style={{
            width: Math.round(stageW * scale),
            height: Math.round(stageH * scale),
          }}
        >
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={`${snapshot.filmOrigin}/__film/stage.html?v=${reloadKey}`}
            title="Stage Preview"
            style={{
              width: stageW,
              height: stageH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />

          {activeBox && (
            <div
              className="stage-gizmo"
              style={{
                left: activeBox.left * scale,
                top: activeBox.top * scale,
                width: activeBox.width * scale,
                height: activeBox.height * scale,
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
                startBoxInteraction('move', e.clientX, e.clientY);
              }}
            >
              <div className="gizmo-label">{selectedClip?.id}</div>
              <div
                className="gizmo-handle"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  startBoxInteraction('resize', e.clientX, e.clientY);
                }}
              />
            </div>
          )}

          {activeSubtitles.length > 0 && (
            <div className="stage-subtitles">
              {activeSubtitles.map((sub, i) => (
                <div key={i} className="subtitle-pill">
                  {sub.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="transport-bar">
        <button className="btn-icon" onClick={() => onSeek(0)} title="回到开头">
          <RotateCcw size={15} />
        </button>
        <button className="btn-primary-round" onClick={onTogglePlay} title={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="timecode">
          {formatClock(currentTime)} <span className="muted">/ {formatClock(snapshot.durationSec)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, snapshot.durationSec)}
          step={0.01}
          value={Math.min(currentTime, Math.max(0.1, snapshot.durationSec))}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="transport-scrubber"
        />
        <span className="stage-badge">
          {stageW}×{stageH} · {snapshot.report.fps ?? snapshot.doc.fps}fps
        </span>
      </div>
    </div>
  );
}
