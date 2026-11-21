import { useState } from 'react';
import { Camera, Send, Sparkles, Terminal } from 'lucide-react';
import { requestLook, sendAgentChat } from '../api';
import type { LookFrameResult, ProjectSnapshot } from '../types';

interface AgentPanelProps {
  snapshot: ProjectSnapshot;
  currentTime: number;
  onSnapshotUpdate: (s: ProjectSnapshot) => void;
  onEdit: (ops: Array<Record<string, unknown>>, why: string, author: 'human' | 'agent') => Promise<void>;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  toolTrace?: Array<{ tool: string; resultSummary: string }>;
}

const DEFAULT_OPS = JSON.stringify(
  [{ op: 'param', clip: 'intro', name: 'accent', value: '#ff6b35' }],
  null,
  2,
);

export function AgentPanel({ currentTime, onSnapshotUpdate, onEdit }: AgentPanelProps) {
  const [opsText, setOpsText] = useState(DEFAULT_OPS);
  const [whyText, setWhyText] = useState('通过结构化指令更新参数');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('od_llm_base') || 'https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('od_llm_key') || '');
  const [model, setModel] = useState(() => localStorage.getItem('od_llm_model') || 'gpt-4o-mini');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [lookResults, setLookResults] = useState<LookFrameResult[]>([]);

  const runDirectOps = async () => {
    setStatusMsg(null);
    try {
      const parsed = JSON.parse(opsText);
      const ops = Array.isArray(parsed) ? parsed : [parsed];
      await onEdit(ops, whyText || '结构化指令编辑', 'agent');
      setStatusMsg('已应用结构化修改到 composition.html');
    } catch (err) {
      setStatusMsg(`失败：${(err as Error).message}`);
    }
  };

  const runChat = async () => {
    if (!prompt.trim()) return;
    if (apiKey.trim()) {
      localStorage.setItem('od_llm_base', apiBase);
      localStorage.setItem('od_llm_key', apiKey);
      localStorage.setItem('od_llm_model', model);
    }
    const userMsg = prompt.trim();
    const nextHistory = [...messages, { role: 'user' as const, content: userMsg }];
    setMessages(nextHistory);
    setPrompt('');
    setBusy(true);
    setStatusMsg(null);

    try {
      const res = await sendAgentChat({
        prompt: userMsg,
        currentTime,
        apiBase,
        apiKey,
        model,
        history: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      onSnapshotUpdate(res.snapshot);
      setMessages([
        ...nextHistory,
        { role: 'assistant', content: res.reply, toolTrace: res.toolTrace },
      ]);
    } catch (err) {
      setMessages([
        ...nextHistory,
        { role: 'assistant', content: `执行失败：${(err as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const inspectCurrentFrame = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await requestLook([Number(currentTime.toFixed(2))]);
      setLookResults(res.frames);
    } catch (err) {
      setStatusMsg(`抽帧检查失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-panel">
      <div className="section-head">
        <span><Sparkles size={14} /> AI 导演多轮协作</span>
      </div>

      <div className="chat-thread">
        {messages.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>
            可直接输入中文指令（无 Key 也支持：「把强调色改成紫色」「在 1.5 秒处切开」「添加 0.5 秒淡入淡出」「开启自动闪避」）；填入 API Key 后可开启多轮工具调用 + 看图自检。
          </div>
        ) : (
          messages.map((m, idx) => (
            <div key={idx} className={`chat-bubble ${m.role}`}>
              <div>{m.content}</div>
              {m.toolTrace && m.toolTrace.length > 0 && (
                <div className="tool-trace-list">
                  {m.toolTrace.map((t, ti) => (
                    <div key={ti} className="tool-trace-pill">
                      <code>{t.tool}</code> · {t.resultSummary}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <textarea
        rows={2}
        placeholder="告诉 AI 导演怎么改这期视频…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void runChat();
          }
        }}
      />

      <div className="btn-row">
        <button className="btn-primary" style={{ flex: 1, justifyContent: 'center' }} disabled={busy} onClick={() => void runChat()}>
          <Send size={13} /> {busy ? '处理中…' : '发送指令'}
        </button>
        <button className="btn-secondary" disabled={busy} onClick={() => void inspectCurrentFrame()}>
          <Camera size={13} /> 抽帧看图
        </button>
      </div>

      <details className="llm-settings">
        <summary>BYO 模型配置（可选，OpenAI 兼容接口）</summary>
        <input placeholder="Base URL" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
        <input placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
        <input type="password" placeholder="API Key (仅存本地)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </details>

      <details className="llm-settings">
        <summary><Terminal size={12} /> 结构化 Ops 直执行</summary>
        <input
          type="text"
          value={whyText}
          onChange={(e) => setWhyText(e.target.value)}
          placeholder="修改原因 (why)"
        />
        <textarea
          rows={5}
          className="mono"
          value={opsText}
          onChange={(e) => setOpsText(e.target.value)}
        />
        <button className="btn-secondary" onClick={() => void runDirectOps()}>
          提交原子 Ops
        </button>
      </details>

      {statusMsg && <div className="status-banner">{statusMsg}</div>}

      {lookResults.length > 0 && (
        <div className="look-box">
          {lookResults.map((f, idx) => (
            <div key={idx} className="look-card">
              <img src={f.dataUrl} alt={`t=${f.timeSec}s`} />
              <div className="look-meta">
                t={f.timeSec}s · 样例提醒:{f.warnings.samples.length} · 溢出:{f.warnings.overflows.length}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
