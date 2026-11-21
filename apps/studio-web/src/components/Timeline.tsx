import { useRef, useState } from 'react';
import { Eye, EyeOff, Lock, Scissors, Trash2, Unlock, Volume2, VolumeX } from 'lucide-react';
import type { CompositionClip, ProjectSnapshot } from '../types';

interface TimelineProps {
  snapshot: ProjectSnapshot;
  currentTime: number;
  selectedClipId: string | null;
  highlightedClipIds: string[];
  onSelectClip: (clipId: string) => void;
  onSeek: (t: number) => void;
  onEdit: (ops: Array<Record<string, unknown>>, why: string) => Promise<void>;
}

function getClipDuration(clip: CompositionClip, snapshot: ProjectSnapshot): number {
  const media = snapshot.mediaInfo[clip.src];
  const page = snapshot.pageMeta[clip.src];
  const srcEnd = clip.outSec ?? media?.durationSec ?? page?.duration;
  if (srcEnd === undefined) return 4;
  return Math.max(0.1, (srcEnd - clip.inSec) / (clip.speed || 1));
}

export function Timeline({
  snapshot,
  currentTime,
  selectedClipId,
  highlightedClipIds,
  onSelectClip,
  onSeek,
  onEdit,
}: TimelineProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [dragPreview, setDragPreview] = useState<{
    clipId: string;
    at: number;
    dur: number;
    inSec: number;
    outSec?: number;
  } | null>(null);
  const totalSec = Math.max(4, snapshot.durationSec + 1);
  const pxPerSec = 95;
  const trackWidth = Math.max(760, Math.ceil(totalSec * pxPerSec));

  const seekFromMouse = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, clientX - rect.left);
    onSeek(Math.min(snapshot.durationSec, x / pxPerSec));
  };

  const startClipMove = (clip: CompositionClip, dur: number, startClientX: number) => {
    const startAt = clip.at;
    let latestAt = startAt;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startClientX;
      latestAt = Math.max(0, Math.round((startAt + dx / pxPerSec) * 100) / 100);
      setDragPreview({ clipId: clip.id, at: latestAt, dur, inSec: clip.inSec, outSec: clip.outSec });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setDragPreview(null);
      if (Math.abs(latestAt - startAt) >= 0.01) {
        void onEdit([{ op: 'move', clip: clip.id, at: latestAt }], `拖动片段 ${clip.id} 到 ${latestAt.toFixed(2)}s`);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startClipTrim = (clip: CompositionClip, dur: number, edge: 'left' | 'right', startClientX: number) => {
    const origAt = clip.at;
    const origIn = clip.inSec;
    const origOut = clip.outSec ?? origIn + dur * clip.speed;
    let nextAt = origAt;
    let nextIn = origIn;
    let nextOut = origOut;
    let nextDur = dur;

    const onMove = (ev: MouseEvent) => {
      const dt = (ev.clientX - startClientX) / pxPerSec;
      if (edge === 'left') {
        const maxShift = dur - 0.1;
        const clampedDt = Math.max(-origAt, Math.max(-origIn / clip.speed, Math.min(maxShift, dt)));
        nextAt = Math.round((origAt + clampedDt) * 100) / 100;
        nextIn = Math.max(0, Math.round((origIn + clampedDt * clip.speed) * 100) / 100);
        nextDur = Math.max(0.1, dur - clampedDt);
      } else {
        const deltaSrc = dt * clip.speed;
        nextOut = Math.max(origIn + 0.1 * clip.speed, Math.round((origOut + deltaSrc) * 100) / 100);
        nextDur = Math.max(0.1, (nextOut - origIn) / clip.speed);
      }
      setDragPreview({ clipId: clip.id, at: nextAt, dur: nextDur, inSec: nextIn, outSec: nextOut });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setDragPreview(null);
      const ops: Array<Record<string, unknown>> = [];
      if (edge === 'left' && (Math.abs(nextAt - origAt) >= 0.02 || Math.abs(nextIn - origIn) >= 0.02)) {
        ops.push({ op: 'move', clip: clip.id, at: nextAt });
        ops.push({ op: 'trim', clip: clip.id, from: nextIn, to: origOut });
      } else if (edge === 'right' && Math.abs(nextOut - origOut) >= 0.02) {
        ops.push({ op: 'trim', clip: clip.id, from: origIn, to: nextOut });
      }
      if (ops.length > 0) {
        void onEdit(ops, `裁剪片段 ${clip.id} (${edge === 'left' ? '入点' : '出点'})`);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleSplitSelected = () => {
    if (!selectedClipId) return;
    void onEdit(
      [{ op: 'split', clip: selectedClipId, atFilmSec: Number(currentTime.toFixed(3)) }],
      `在 ${currentTime.toFixed(2)}s 处切开片段 ${selectedClipId}`,
    );
  };

  const handleDeleteSelected = () => {
    if (!selectedClipId) return;
    void onEdit([{ op: 'remove', clip: selectedClipId }], `删除片段 ${selectedClipId}`);
  };

  const ticks: number[] = [];
  for (let s = 0; s <= Math.ceil(totalSec); s += 1) ticks.push(s);

  const resolvedCues = Object.values(snapshot.cues).filter((c) => c.status === 'ok' && typeof c.filmSec === 'number');

  return (
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <span className="muted">时间线编辑</span>
        <div className="timeline-tools-group">
          <button className="btn-secondary" disabled={!selectedClipId} onClick={handleSplitSelected} title="在播放头位置分割选中片段">
            <Scissors size={12} /> 切开片段
          </button>
          <button className="btn-secondary" disabled={!selectedClipId} onClick={handleDeleteSelected} title="删除选中片段">
            <Trash2 size={12} /> 删除
          </button>
        </div>
      </div>

      <div className="timeline-scroll">
        <div className="timeline-header-row">
          <div className="track-controls-col">时间尺 / Cues</div>
          <div
            className="ruler-track"
            ref={rulerRef}
            style={{ width: trackWidth }}
            onMouseDown={(e) => seekFromMouse(e.clientX)}
          >
            {ticks.map((s) => (
              <div key={s} className="ruler-tick" style={{ left: s * pxPerSec }}>
                <span>{s}s</span>
              </div>
            ))}
            {resolvedCues.map((cue) => (
              <div
                key={cue.name}
                className="cue-marker"
                style={{ left: (cue.filmSec ?? 0) * pxPerSec }}
                title={`Cue: ${cue.name} @ ${cue.filmSec?.toFixed(2)}s`}
              >
                {cue.name}
              </div>
            ))}
            <div className="playhead-cap" style={{ left: currentTime * pxPerSec }} />
          </div>
        </div>

        {snapshot.subtitles.length > 0 && (
          <div className="subtitle-lane-row">
            <div className="track-controls-col muted">字幕轨</div>
            <div className="subtitle-lane" style={{ width: trackWidth }}>
              {snapshot.subtitles.map((sub, i) => (
                <div
                  key={i}
                  className="subtitle-chip"
                  style={{
                    left: sub.startSec * pxPerSec,
                    width: Math.max(24, (sub.endSec - sub.startSec) * pxPerSec),
                  }}
                  title={sub.text}
                >
                  {sub.text}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="timeline-tracks-body">
          {snapshot.doc.tracks.map((track, ti) => (
            <div key={ti} className={`track-row ${track.hidden ? 'is-hidden' : ''}`}>
              <div className="track-controls-col">
                <span className="track-name">{track.id || `Track ${ti + 1}`}</span>
                <div className="track-toggles">
                  <button
                    className={`mini-toggle ${track.hidden ? 'active' : ''}`}
                    title="显示/隐藏轨道"
                    onClick={() =>
                      void onEdit([{ op: 'track', from: ti, hidden: !track.hidden }], `切换轨道 ${ti + 1} 显示状态`)
                    }
                  >
                    {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button
                    className={`mini-toggle ${track.muted ? 'active' : ''}`}
                    title="静音轨道"
                    onClick={() =>
                      void onEdit([{ op: 'track', from: ti, muted: !track.muted }], `切换轨道 ${ti + 1} 静音状态`)
                    }
                  >
                    {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                  <button
                    className={`mini-toggle ${track.locked ? 'active' : ''}`}
                    title="锁定轨道"
                    onClick={() =>
                      void onEdit([{ op: 'track', from: ti, locked: !track.locked }], `切换轨道 ${ti + 1} 锁定状态`)
                    }
                  >
                    {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
                  </button>
                </div>
              </div>

              <div className="track-lane" style={{ width: trackWidth }}>
                <div className="playhead-line" style={{ left: currentTime * pxPerSec }} />
                {track.clips.map((clip) => {
                  const baseDur = getClipDuration(clip, snapshot);
                  const preview = dragPreview?.clipId === clip.id ? dragPreview : null;
                  const shownAt = preview ? preview.at : clip.at;
                  const shownDur = preview ? preview.dur : baseDur;
                  const selected = selectedClipId === clip.id;
                  const highlighted = highlightedClipIds.includes(clip.id);
                  return (
                    <div
                      key={clip.id}
                      className={`clip-block kind-${clip.kind} ${selected ? 'selected' : ''} ${highlighted ? 'follow-highlight' : ''}`}
                      style={{
                        left: shownAt * pxPerSec,
                        width: Math.max(28, shownDur * pxPerSec),
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        onSelectClip(clip.id);
                        if (!track.locked) startClipMove(clip, baseDur, e.clientX);
                      }}
                    >
                      {!track.locked && (
                        <div
                          className="trim-handle left"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            onSelectClip(clip.id);
                            startClipTrim(clip, baseDur, 'left', e.clientX);
                          }}
                        />
                      )}
                      <span className="clip-title">{clip.id}</span>
                      <span className="clip-meta">{shownDur.toFixed(1)}s</span>
                      {!track.locked && (
                        <div
                          className="trim-handle right"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            onSelectClip(clip.id);
                            startClipTrim(clip, baseDur, 'right', e.clientX);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
