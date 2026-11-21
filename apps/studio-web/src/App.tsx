import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileCode2, FileText, Film, History, Sliders, Sparkles, Undo2 } from 'lucide-react';
import { fetchProject, startExport, submitEdit, submitUndo } from './api';
import { AgentPanel } from './components/AgentPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { Inspector } from './components/Inspector';
import { LeftPanel } from './components/LeftPanel';
import { StagePreview } from './components/StagePreview';
import { Timeline } from './components/Timeline';
import type { CompositionClip, ProjectSnapshot } from './types';

type RightTab = 'inspector' | 'history' | 'agent';

export function App() {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [highlightedClipIds, setHighlightedClipIds] = useState<string[]>([]);
  const [followToast, setFollowToast] = useState<string | null>(null);
  const [tab, setTab] = useState<RightTab>('inspector');
  const [reloadKey, setReloadKey] = useState(0);
  const [exportState, setExportState] = useState<{ running: boolean; percent: number; msg?: string }>({
    running: false,
    percent: 0,
  });

  const applySnapshot = useCallback((next: ProjectSnapshot) => {
    setSnapshot(next);
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySnapshot(await fetchProject());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [applySnapshot]);

  const triggerFollowAlong = useCallback(
    (msg: { author?: string; why?: string; affectedClipIds?: string[]; focusTimeSec?: number }) => {
      if (Array.isArray(msg.affectedClipIds) && msg.affectedClipIds.length > 0) {
        setHighlightedClipIds(msg.affectedClipIds);
        setTimeout(() => setHighlightedClipIds([]), 2400);
      }
      if (typeof msg.focusTimeSec === 'number') {
        setPlaying(false);
        setCurrentTime(msg.focusTimeSec);
      }
      if (msg.why) {
        setFollowToast(`${msg.author === 'agent' ? 'AI 修改：' : ''}${msg.why}`);
        setTimeout(() => setFollowToast(null), 3200);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'project-updated' || msg.type === 'project-switched') {
          void refresh();
          if (msg.type === 'project-updated') triggerFollowAlong(msg);
        } else if (msg.type === 'export-progress') {
          setExportState({ running: true, percent: msg.percent ?? 0, msg: `导出中 ${msg.frame}/${msg.totalFrames}` });
        } else if (msg.type === 'export-done') {
          setExportState({ running: false, percent: 100, msg: `导出完成：${msg.result?.outPath}` });
        } else if (msg.type === 'export-error') {
          setExportState({ running: false, percent: 0, msg: `导出失败：${msg.message}` });
        }
      } catch {}
    };
    return () => ws.close();
  }, [refresh, triggerFollowAlong]);

  const playStateRef = useRef({ playing, currentTime, duration: 0 });
  playStateRef.current = {
    playing,
    currentTime,
    duration: snapshot?.durationSec ?? 0,
  };

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCurrentTime((prev) => {
        const next = prev + dt;
        if (next >= playStateRef.current.duration) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const selectedClip = useMemo<CompositionClip | null>(() => {
    if (!snapshot || !selectedClipId) return null;
    for (const track of snapshot.doc.tracks) {
      const found = track.clips.find((c) => c.id === selectedClipId);
      if (found) return found;
    }
    return null;
  }, [snapshot, selectedClipId]);

  const handleEdit = async (
    ops: Array<Record<string, unknown>>,
    why: string,
    author: 'human' | 'agent' = 'human',
  ) => {
    try {
      const res = await submitEdit(ops, why, author);
      applySnapshot(res.snapshot);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleUndo = async () => {
    try {
      const res = await submitUndo();
      applySnapshot(res.snapshot);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleExport = async () => {
    try {
      setExportState({ running: true, percent: 0, msg: '启动导出…' });
      await startExport('output.mp4');
    } catch (err) {
      setExportState({ running: false, percent: 0, msg: (err as Error).message });
    }
  };

  if (!snapshot) {
    return (
      <div className="loading-screen">
        {error ? `加载失败：${error}` : '正在加载 Open Director 工程…'}
      </div>
    );
  }

  const projectName =
    snapshot.manifest.manifest.project?.name || snapshot.manifest.manifest.template?.name || 'Open Director';

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <Film size={18} />
          <strong>Open Director</strong>
          <span className="project-name">{projectName}</span>
        </div>

        <div className="top-actions">
          {exportState.msg && <span className="export-msg">{exportState.msg}</span>}
          <a className="btn-secondary" href="/api/export/fcpxml" download="timeline.fcpxml">
            <FileCode2 size={13} /> FCPXML
          </a>
          <a className="btn-secondary" href="/api/export/subtitles?format=srt" download="subtitles.srt">
            <FileText size={13} /> SRT
          </a>
          <button
            className="btn-secondary"
            disabled={snapshot.history.length === 0}
            onClick={() => void handleUndo()}
          >
            <Undo2 size={14} /> 撤销 ({snapshot.history.length})
          </button>
          <button className="btn-primary" disabled={exportState.running} onClick={() => void handleExport()}>
            <Download size={14} /> {exportState.running ? `导出 ${exportState.percent}%` : '导出 MP4'}
          </button>
        </div>
      </header>

      {error && <div className="error-strip">{error}</div>}
      {followToast && <div className="follow-toast">{followToast}</div>}

      <main className="workspace-main">
        <LeftPanel
          snapshot={snapshot}
          currentTime={currentTime}
          onSnapshotUpdate={applySnapshot}
          onEdit={(ops, why) => handleEdit(ops, why, 'human')}
        />

        <StagePreview
          snapshot={snapshot}
          currentTime={currentTime}
          playing={playing}
          selectedClip={selectedClip}
          onTogglePlay={() => setPlaying((p) => !p)}
          onSeek={(t) => {
            setPlaying(false);
            setCurrentTime(t);
          }}
          onEdit={(ops, why) => handleEdit(ops, why, 'human')}
          reloadKey={reloadKey}
        />

        <aside className="right-drawer">
          <div className="drawer-tabs">
            <button className={tab === 'inspector' ? 'active' : ''} onClick={() => setTab('inspector')}>
              <Sliders size={14} /> 属性
            </button>
            <button className={tab === 'agent' ? 'active' : ''} onClick={() => setTab('agent')}>
              <Sparkles size={14} /> AI 导演
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              <History size={14} /> 历史
            </button>
          </div>
          <div className="drawer-content">
            {tab === 'inspector' && <Inspector snapshot={snapshot} clip={selectedClip} onEdit={handleEdit} />}
            {tab === 'agent' && (
              <AgentPanel
                snapshot={snapshot}
                currentTime={currentTime}
                onSnapshotUpdate={applySnapshot}
                onEdit={handleEdit}
              />
            )}
            {tab === 'history' && <HistoryPanel history={snapshot.history} onUndo={handleUndo} />}
          </div>
        </aside>
      </main>

      <Timeline
        snapshot={snapshot}
        currentTime={currentTime}
        selectedClipId={selectedClipId}
        highlightedClipIds={highlightedClipIds}
        onSelectClip={(id) => {
          setSelectedClipId(id);
          setTab('inspector');
        }}
        onSeek={(t) => {
          setPlaying(false);
          setCurrentTime(t);
        }}
        onEdit={handleEdit}
      />
    </div>
  );
}
