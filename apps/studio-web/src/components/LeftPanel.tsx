import { useEffect, useState } from 'react';
import { Activity, FolderOpen, LayoutTemplate, Music, Plus, ShieldCheck, Upload, Volume2 } from 'lucide-react';
import {
  analyzeBeatsApi,
  fetchTemplates,
  instantiateTemplateApi,
  matchLoudnessApi,
  runAudit,
  uploadAssetFile,
} from '../api';
import type { AuditReport, ProjectSnapshot, TemplateSummary } from '../types';

interface LeftPanelProps {
  snapshot: ProjectSnapshot;
  currentTime: number;
  onSnapshotUpdate: (s: ProjectSnapshot) => void;
  onEdit: (ops: Array<Record<string, unknown>>, why: string) => Promise<void>;
}

type LeftTab = 'assets' | 'templates' | 'audit';

export function LeftPanel({ snapshot, currentTime, onSnapshotUpdate, onEdit }: LeftPanelProps) {
  const [tab, setTab] = useState<LeftTab>('assets');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (tab === 'templates' && templates.length === 0) {
      void fetchTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
    }
  }, [tab, templates.length]);

  const handleUpload = async (file: File) => {
    setBusyMsg(`正在导入 ${file.name}…`);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await uploadAssetFile(file.name, b64, file.name.endsWith('.html') ? 'scenes' : 'assets');
      onSnapshotUpdate(res.snapshot);
      setBusyMsg(`已导入 ${res.relPath}`);
    } catch (err) {
      setBusyMsg(`导入失败：${(err as Error).message}`);
    }
  };

  const handleAddAsset = (relPath: string, kind: 'image' | 'video' | 'audio' | 'page', dur?: number) => {
    const startAt = Number(currentTime.toFixed(2));
    const clipSpec: Record<string, unknown> = {
      src: relPath,
      at: startAt,
      from: 0,
      ...(kind === 'image' ? { to: 3 } : dur ? { to: Number(dur.toFixed(2)) } : {}),
    };
    const trackChoice = kind === 'audio' ? 'new' : kind === 'page' ? 'top' : 0;
    void onEdit([{ op: 'add', clip: clipSpec, track: trackChoice }], `从素材库添加 ${relPath} 到 ${startAt}s`);
  };

  const handleRunAudit = async () => {
    setBusyMsg('正在执行成片预检…');
    try {
      setAudit(await runAudit());
      setBusyMsg(null);
    } catch (err) {
      setBusyMsg(`预检失败：${(err as Error).message}`);
    }
  };

  const handleLoudnessMatch = async () => {
    setBusyMsg('正在测量 LUFS 并匹配各轨响度…');
    try {
      const res = await matchLoudnessApi(true);
      if (res.snapshot) onSnapshotUpdate(res.snapshot);
      setBusyMsg(`已按角色统一 ${res.plans.length} 条音轨响度`);
      setAudit(await runAudit());
    } catch (err) {
      setBusyMsg(`响度匹配失败：${(err as Error).message}`);
    }
  };

  return (
    <aside className="left-drawer">
      <div className="drawer-tabs">
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
          <FolderOpen size={13} /> 素材
        </button>
        <button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>
          <LayoutTemplate size={13} /> 模板
        </button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          <ShieldCheck size={13} /> 预检
        </button>
      </div>

      <div className="drawer-content">
        {busyMsg && <div className="status-banner" style={{ marginBottom: 10 }}>{busyMsg}</div>}

        {tab === 'assets' && (
          <div className="left-list">
            <label className="upload-btn">
              <Upload size={13} /> 导入音视频/图片/页面
              <input
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUpload(f);
                  e.target.value = '';
                }}
              />
            </label>

            {snapshot.assets.map((asset) => (
              <div key={asset.relPath} className="asset-card">
                <div className="asset-info">
                  <div className="asset-name">{asset.relPath}</div>
                  <div className="asset-meta">
                    {asset.kind} · {(asset.bytes / 1024).toFixed(1)} KB
                    {asset.durationSec ? ` · ${asset.durationSec.toFixed(1)}s` : ''}
                  </div>
                </div>
                <div className="asset-actions">
                  {asset.kind === 'audio' && (
                    <button
                      className="mini-toggle"
                      title="分析节拍 (BPM)"
                      onClick={() => {
                        setBusyMsg(`正在提取 ${asset.relPath} 节拍…`);
                        void analyzeBeatsApi(asset.relPath)
                          .then((r) => {
                            onSnapshotUpdate(r.snapshot);
                            setBusyMsg(`${asset.relPath}: ${r.beats.bpm} BPM (${r.beats.beats.length} 拍)`);
                          })
                          .catch((e) => setBusyMsg((e as Error).message));
                      }}
                    >
                      <Music size={12} />
                    </button>
                  )}
                  <button
                    className="mini-toggle"
                    title="插入到当前播放头"
                    onClick={() => handleAddAsset(asset.relPath, asset.kind, asset.durationSec)}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'templates' && (
          <div className="left-list">
            {templates.map((tpl) => (
              <div key={tpl.id} className="tpl-card">
                <div className="tpl-title">{tpl.name}</div>
                <div className="tpl-meta">{tpl.width}×{tpl.height} · {tpl.fps}fps · v{tpl.version}</div>
                {tpl.description && <div className="tpl-desc">{tpl.description}</div>}
                <button
                  className="btn-primary"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  onClick={() => {
                    setBusyMsg(`正在从模板「${tpl.name}」创建新工程…`);
                    void instantiateTemplateApi(tpl.id)
                      .then((r) => {
                        onSnapshotUpdate(r.snapshot);
                        setBusyMsg(`已切换到新工程：${tpl.name}`);
                      })
                      .catch((e) => setBusyMsg((e as Error).message));
                  }}
                >
                  使用此模板新建工程
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === 'audit' && (
          <div className="left-list">
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button className="btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => void handleRunAudit()}>
                <Activity size={13} /> 立即预检
              </button>
              <button className="btn-secondary" onClick={() => void handleLoudnessMatch()}>
                <Volume2 size={13} /> 响度统一
              </button>
            </div>

            {audit && (
              <div className="audit-results">
                <div className="audit-group">
                  <strong>未替换样例 ({audit.samples.length})</strong>
                  {audit.samples.length === 0 ? (
                    <div className="muted">无</div>
                  ) : (
                    audit.samples.map((s, i) => (
                      <div key={i} className="audit-item warn">
                        t={s.timeSec}s · {s.clipId}: {s.hint}
                      </div>
                    ))
                  )}
                </div>
                <div className="audit-group">
                  <strong>文字溢出 ({audit.overflows.length})</strong>
                  {audit.overflows.length === 0 ? (
                    <div className="muted">无</div>
                  ) : (
                    audit.overflows.map((o, i) => (
                      <div key={i} className="audit-item warn">
                        t={o.timeSec}s · {o.clipId}: {o.text}
                      </div>
                    ))
                  )}
                </div>
                <div className="audit-group">
                  <strong>音轨响度实测 ({audit.audioLoudness.length})</strong>
                  {audit.audioLoudness.map((a) => (
                    <div key={a.clipId} className="audit-item">
                      {a.clipId}: {a.measuredLufs.toFixed(1)} LUFS (峰值 {a.measuredTruePeakDbtp.toFixed(1)} dBTP)
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
