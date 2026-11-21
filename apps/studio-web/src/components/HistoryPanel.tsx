import { Undo2 } from 'lucide-react';
import type { HistoryItem } from '../types';

interface HistoryPanelProps {
  history: HistoryItem[];
  onUndo: () => Promise<void>;
}

export function HistoryPanel({ history, onUndo }: HistoryPanelProps) {
  if (history.length === 0) {
    return <div className="panel-empty">暂无操作记录。每一次人手或 AI 修改都会写进 `.open-director/history.jsonl`。</div>;
  }

  return (
    <div className="history-list">
      <div className="history-top-bar">
        <span>共 {history.length} 步改动</span>
        <button className="btn-secondary" onClick={() => void onUndo()}>
          <Undo2 size={13} /> 撤销最近一步
        </button>
      </div>
      {[...history].reverse().map((item) => (
        <div key={item.id} className="history-card">
          <div className="history-meta">
            <span className={`author-badge ${item.author}`}>{item.author === 'agent' ? 'AI' : '手动'}</span>
            <span className="muted">{new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
          <div className="history-why">{item.why}</div>
          <ul className="history-changes">
            {item.changes.map((c, idx) => (
              <li key={idx}>{c}</li>
            ))}
          </ul>
          {item.diffLines && item.diffLines.length > 0 && (
            <details className="diff-details">
              <summary>查看 composition.html 代码 Diff</summary>
              <pre className="diff-pre">
                {item.diffLines.map((line, i) => (
                  <div key={i} className={line.startsWith('+') ? 'diff-add' : 'diff-del'}>
                    {line}
                  </div>
                ))}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
