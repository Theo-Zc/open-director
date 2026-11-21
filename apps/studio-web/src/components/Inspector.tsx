import { RotateCcw } from 'lucide-react';
import type { CompositionClip, ParamDecl, ProjectSnapshot } from '../types';

interface InspectorProps {
  snapshot: ProjectSnapshot;
  clip: CompositionClip | null;
  onEdit: (ops: Array<Record<string, unknown>>, why: string) => Promise<void>;
}

function readParamLiteral(clip: CompositionClip, name: string): string | undefined {
  const root = clip.overrides.find(
    (o): o is Extract<typeof o, { at: string }> => 'at' in o && o.at === ':root',
  );
  return root?.style?.[`--${name}`];
}

function decodeParamValue(decl: ParamDecl, literal: string | undefined): string | number | boolean {
  if (literal === undefined || literal.trim() === '') return decl.default;
  const trimmed = literal.trim();
  if (decl.type === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : decl.default;
  }
  if (decl.type === 'toggle') return trimmed === '1' || trimmed === 'true';
  if (decl.type === 'text' && trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return trimmed;
}

export function Inspector({ snapshot, clip, onEdit }: InspectorProps) {
  if (!clip) {
    return (
      <div className="panel-empty">
        点击时间线上的任意片段，即可调整时间、画布坐标、人声闪避和页面声明的参数（`film.params`）。
      </div>
    );
  }

  const fadeEntry = clip.overrides.find((o): o is { fade: [number, number] } => 'fade' in o);
  const [fadeIn, fadeOut] = fadeEntry?.fade ?? [0, 0];
  const isDucked = Boolean(clip.passthroughAttrs?.['data-adudir-duck']);
  const pageDecls = clip.kind === 'page' ? snapshot.pageMeta[clip.src]?.params ?? {} : {};
  const paramEntries = Object.entries(pageDecls);

  return (
    <div className="inspector-body">
      <div className="section-head">
        <span>片段：{clip.id}</span>
        <span className="pill">{clip.kind}</span>
      </div>
      <div className="muted small-path">{clip.src}</div>

      <div className="form-grid">
        <label>
          <span>开始时刻 at (s)</span>
          <input
            type="number"
            step={0.1}
            min={0}
            defaultValue={clip.at}
            key={`at-${clip.id}-${clip.at}`}
            onBlur={(e) => {
              const val = Math.max(0, Number(e.target.value));
              if (Number.isFinite(val) && Math.abs(val - clip.at) > 1e-4) {
                void onEdit([{ op: 'move', clip: clip.id, at: val }], `调整 ${clip.id} 开始时刻为 ${val}s`);
              }
            }}
          />
        </label>
        <label>
          <span>入点 in (s)</span>
          <input
            type="number"
            step={0.1}
            min={0}
            defaultValue={clip.inSec}
            key={`in-${clip.id}-${clip.inSec}`}
            onBlur={(e) => {
              const val = Math.max(0, Number(e.target.value));
              if (Number.isFinite(val) && Math.abs(val - clip.inSec) > 1e-4) {
                void onEdit(
                  [{ op: 'trim', clip: clip.id, from: val, ...(clip.outSec !== undefined ? { to: clip.outSec } : {}) }],
                  `调整 ${clip.id} 入点为 ${val}s`,
                );
              }
            }}
          />
        </label>
      </div>

      {clip.kind !== 'audio' && (
        <div className="form-grid">
          <label>
            <span>X (left px)</span>
            <input
              type="number"
              defaultValue={clip.box.left ?? 0}
              key={`left-${clip.id}-${clip.box.left ?? 0}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v !== (clip.box.left ?? 0)) {
                  void onEdit([{ op: 'box', clip: clip.id, left: v }], `调整 ${clip.id} left=${v}px`);
                }
              }}
            />
          </label>
          <label>
            <span>Y (top px)</span>
            <input
              type="number"
              defaultValue={clip.box.top ?? 0}
              key={`top-${clip.id}-${clip.box.top ?? 0}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v !== (clip.box.top ?? 0)) {
                  void onEdit([{ op: 'box', clip: clip.id, top: v }], `调整 ${clip.id} top=${v}px`);
                }
              }}
            />
          </label>
        </div>
      )}

      {(clip.kind === 'video' || clip.kind === 'audio') && (
        <>
          <div className="form-grid">
            <label>
              <span>倍速 ({clip.speed.toFixed(2)}x)</span>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                value={clip.speed}
                onChange={(e) =>
                  void onEdit(
                    [{ op: 'set', clip: clip.id, speed: Number(e.target.value) }],
                    `调整 ${clip.id} 速度为 ${e.target.value}x`,
                  )
                }
              />
            </label>
            <label>
              <span>音量 ({Math.round(clip.volume * 100)}%)</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={clip.volume}
                onChange={(e) =>
                  void onEdit(
                    [{ op: 'set', clip: clip.id, volume: Number(e.target.value) }],
                    `调整 ${clip.id} 音量为 ${e.target.value}`,
                  )
                }
              />
            </label>
          </div>
          <label className="toggle-row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={isDucked}
              onChange={(e) =>
                void onEdit(
                  [
                    {
                      op: 'attr',
                      clip: clip.id,
                      name: 'data-adudir-duck',
                      value: e.target.checked ? '{"duckDb":-12,"attack":0.15,"release":0.35}' : null,
                    },
                  ],
                  `${e.target.checked ? '开启' : '关闭'} ${clip.id} 人声闪避 (Ducking)`,
                )
              }
            />
            <span>人声出现时自动压低背景音 (-12 dB)</span>
          </label>
        </>
      )}

      <div className="form-grid">
        <label>
          <span>淡入 fade-in (s)</span>
          <input
            type="number"
            step={0.05}
            min={0}
            defaultValue={fadeIn}
            key={`fi-${clip.id}-${fadeIn}`}
            onBlur={(e) => {
              const val = Math.max(0, Number(e.target.value));
              if (Number.isFinite(val) && Math.abs(val - fadeIn) > 1e-4) {
                void onEdit([{ op: 'fade', clip: clip.id, in: val, out: fadeOut }], `设置 ${clip.id} 淡入 ${val}s`);
              }
            }}
          />
        </label>
        <label>
          <span>淡出 fade-out (s)</span>
          <input
            type="number"
            step={0.05}
            min={0}
            defaultValue={fadeOut}
            key={`fo-${clip.id}-${fadeOut}`}
            onBlur={(e) => {
              const val = Math.max(0, Number(e.target.value));
              if (Number.isFinite(val) && Math.abs(val - fadeOut) > 1e-4) {
                void onEdit([{ op: 'fade', clip: clip.id, in: fadeIn, out: val }], `设置 ${clip.id} 淡出 ${val}s`);
              }
            }}
          />
        </label>
      </div>

      {paramEntries.length > 0 && (
        <div className="params-section">
          <div className="section-head">
            <span>页面参数（film.params）</span>
          </div>
          {paramEntries.map(([name, decl]) => {
            const rawLit = readParamLiteral(clip, name);
            const value = decodeParamValue(decl, rawLit);
            const isOverridden = rawLit !== undefined;
            return (
              <div key={name} className="param-row">
                <div className="param-label-row">
                  <span>{decl.label || name}</span>
                  {isOverridden && (
                    <button
                      className="btn-link"
                      title="恢复默认值"
                      onClick={() =>
                        void onEdit(
                          [{ op: 'param', clip: clip.id, name, value: null }],
                          `恢复 ${clip.id} 参数 ${name} 为默认值`,
                        )
                      }
                    >
                      <RotateCcw size={12} /> 重置
                    </button>
                  )}
                </div>

                {decl.type === 'color' && (
                  <div className="color-input-row">
                    <input
                      type="color"
                      value={String(value)}
                      onChange={(e) =>
                        void onEdit(
                          [{ op: 'param', clip: clip.id, name, value: e.target.value }],
                          `修改 ${clip.id} 颜色参数 ${name}`,
                        )
                      }
                    />
                    <code>{String(value)}</code>
                  </div>
                )}

                {decl.type === 'number' && (
                  <div className="number-input-row">
                    <input
                      type="range"
                      min={decl.min ?? 0}
                      max={decl.max ?? 100}
                      step={decl.step ?? 1}
                      value={Number(value)}
                      onChange={(e) =>
                        void onEdit(
                          [{ op: 'param', clip: clip.id, name, value: Number(e.target.value) }],
                          `修改 ${clip.id} 数值参数 ${name}=${e.target.value}`,
                        )
                      }
                    />
                    <span>
                      {String(value)}
                      {decl.unit ?? ''}
                    </span>
                  </div>
                )}

                {decl.type === 'text' && (
                  <input
                    type="text"
                    defaultValue={String(value)}
                    key={`txt-${clip.id}-${name}-${String(value)}`}
                    maxLength={decl.maxLength}
                    onBlur={(e) => {
                      if (e.target.value !== String(value)) {
                        void onEdit(
                          [{ op: 'param', clip: clip.id, name, value: e.target.value }],
                          `修改 ${clip.id} 文本参数 ${name}`,
                        );
                      }
                    }}
                  />
                )}

                {decl.type === 'toggle' && (
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) =>
                        void onEdit(
                          [{ op: 'param', clip: clip.id, name, value: e.target.checked }],
                          `切换 ${clip.id} 开关参数 ${name}`,
                        )
                      }
                    />
                    <span>{Boolean(value) ? '开启' : '关闭'}</span>
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
