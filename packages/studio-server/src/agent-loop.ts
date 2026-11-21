import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitProjectEdit,
  parseComposition,
  type EditOp,
} from '@open-director/protocol';
import {
  BUILTIN_SFX_CATALOG,
  auditProject,
  captureProjectFrames,
  probeProjectMedia,
  readPageMetadata,
  validateProject,
} from '@open-director/engine';

export interface AgentToolTrace {
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
}

export interface AgentChatResult {
  reply: string;
  toolTrace: AgentToolTrace[];
  changed: boolean;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'project_status',
      description: 'Inspect current project duration, tracks, clips, and validation status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_composition',
      description: 'Read current composition.html source.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_params',
      description: 'Read window.film.params and film.sfx of a scene HTML file.',
      parameters: {
        type: 'object',
        required: ['page'],
        properties: { page: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_timeline',
      description: 'Atomically apply EditOps (move, trim, split, set, fade, text, style, param, box, add, remove, ripple, attr, track) to composition.html.',
      parameters: {
        type: 'object',
        required: ['why', 'ops'],
        properties: {
          why: { type: 'string' },
          ops: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_frames',
      description: 'Render deterministic screenshots at specified timestamps (seconds) and check sample/overflow warnings.',
      parameters: {
        type: 'object',
        required: ['times'],
        properties: { times: { type: 'array', items: { type: 'number' } } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sfx',
      description: 'Search built-in procedural SFX catalog.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'audit_project',
      description: 'Check sample placeholders, clipped text, missing assets, and audio loudness.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function executeAgentTool(
  projectDir: string,
  name: string,
  args: Record<string, unknown>,
  onEditCommitted: (info: { why: string; changes: string[]; affectedClipIds?: string[]; focusTimeSec?: number }) => void,
): Promise<{ content: unknown; summary: string; changed: boolean }> {
  switch (name) {
    case 'project_status': {
      const report = await validateProject(projectDir);
      const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
      return {
        content: JSON.stringify({ report, tracks: doc.tracks }),
        summary: `${doc.tracks.length} 轨 · ${report.clipCount ?? 0} 片段 · ${report.durationSec?.toFixed(2)}s`,
        changed: false,
      };
    }
    case 'read_composition': {
      const html = readFileSync(join(projectDir, 'composition.html'), 'utf8');
      return { content: html, summary: `读取 composition.html (${html.length} 字符)`, changed: false };
    }
    case 'list_params': {
      const meta = await readPageMetadata(projectDir, String(args.page));
      return { content: JSON.stringify(meta), summary: `参数数量 ${Object.keys(meta.params).length}`, changed: false };
    }
    case 'edit_timeline': {
      const why = String(args.why || 'AI 编辑');
      const ops = (Array.isArray(args.ops) ? args.ops : []) as EditOp[];
      const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
      const media = await probeProjectMedia(projectDir, doc);
      const intrinsic = new Map<string, number>();
      for (const [k, v] of media.entries()) intrinsic.set(k, v.durationSec);
      const { entry } = commitProjectEdit(projectDir, ops, { why, author: 'agent', intrinsicDurationsSec: intrinsic });
      onEditCommitted({
        why: entry.why,
        changes: entry.changes,
        affectedClipIds: entry.affectedClipIds,
        focusTimeSec: entry.focusTimeSec,
      });
      return {
        content: JSON.stringify({ ok: true, changes: entry.changes }),
        summary: entry.changes.join('；'),
        changed: true,
      };
    }
    case 'look_frames': {
      const times = Array.isArray(args.times) ? args.times.map(Number).slice(0, 4) : [0.5];
      const res = await captureProjectFrames(projectDir, times, { scale: 0.5 });
      const textMeta = JSON.stringify(res.frames.map((f) => ({ t: f.timeSec, warnings: f.warnings })));
      return {
        content: [
          { type: 'text', text: textMeta },
          ...res.frames.map((f) => ({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${f.png.toString('base64')}` },
          })),
        ],
        summary: `查看了 ${res.frames.map((f) => `${f.timeSec}s`).join(', ')}`,
        changed: false,
      };
    }
    case 'list_sfx': {
      const q = String(args.query ?? '').toLowerCase();
      const hits = q
        ? BUILTIN_SFX_CATALOG.filter((s) => s.id.includes(q) || s.title.includes(q) || s.tags.some((t) => t.includes(q)))
        : BUILTIN_SFX_CATALOG;
      return { content: JSON.stringify(hits), summary: `匹配 ${hits.length} 条内置音效`, changed: false };
    }
    case 'audit_project': {
      const audit = await auditProject(projectDir);
      return {
        content: JSON.stringify(audit),
        summary: `样例 ${audit.samples.length} · 溢出 ${audit.overflows.length} · 音轨 ${audit.audioLoudness.length}`,
        changed: false,
      };
    }
    default:
      return { content: JSON.stringify({ error: `Unknown tool ${name}` }), summary: '未知工具', changed: false };
  }
}

/**
 * Deterministic local natural-language command parser when no external LLM API Key is configured.
 */
function runLocalRuleAgent(
  projectDir: string,
  prompt: string,
  currentTime: number,
  onEditCommitted: (info: { why: string; changes: string[]; affectedClipIds?: string[]; focusTimeSec?: number }) => void,
): AgentChatResult {
  const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
  const clips = doc.tracks.flatMap((t) => t.clips);
  const firstPage = clips.find((c) => c.kind === 'page');
  const firstAudio = clips.find((c) => c.kind === 'audio' || c.kind === 'video');
  const text = prompt.trim();

  // Pattern 1: split at time
  const splitMatch = text.match(/(?:在\s*(\d+(?:\.\d+)?)\s*秒?|at\s+(\d+(?:\.\d+)?))\s*(?:处)?(?:切开|分割|剪开|split)/i);
  if (splitMatch || /切开|分割|split/i.test(text)) {
    const t = splitMatch ? Number(splitMatch[1] ?? splitMatch[2]) : Number(currentTime.toFixed(2));
    const target = clips.find((c) => c.kind !== 'audio' && t > c.at + 0.1 && (c.outSec ? t < c.at + (c.outSec - c.inSec) / c.speed - 0.1 : true));
    if (target) {
      const { entry } = commitProjectEdit(projectDir, [{ op: 'split', clip: target.id, atFilmSec: t }], {
        why: `在 ${t}s 处切开片段 ${target.id}`,
        author: 'agent',
      });
      onEditCommitted({ why: entry.why, changes: entry.changes, affectedClipIds: entry.affectedClipIds, focusTimeSec: entry.focusTimeSec });
      return {
        reply: `已在第 ${t} 秒处将「${target.id}」一分为二（可随时撤销）。`,
        toolTrace: [{ tool: 'edit_timeline', args: { op: 'split', clip: target.id, atFilmSec: t }, resultSummary: entry.changes.join('；') }],
        changed: true,
      };
    }
  }

  // Pattern 2: fade in / out
  const fadeMatch = text.match(/(\d+(?:\.\d+)?)\s*秒?.*(?:淡入|淡出|fade)/i) || (/(?:淡入|淡出|fade)/i.test(text) ? ['0.4', '0.4'] : null);
  if (fadeMatch && (firstAudio || firstPage)) {
    const target = firstAudio ?? firstPage!;
    const sec = Number(fadeMatch[1]) || 0.4;
    const { entry } = commitProjectEdit(projectDir, [{ op: 'fade', clip: target.id, in: sec, out: sec }], {
      why: `为 ${target.id} 设置 ${sec}s 淡入淡出`,
      author: 'agent',
    });
    onEditCommitted({ why: entry.why, changes: entry.changes, affectedClipIds: entry.affectedClipIds, focusTimeSec: entry.focusTimeSec });
    return {
      reply: `已为片段「${target.id}」添加 ${sec} 秒淡入与淡出。`,
      toolTrace: [{ tool: 'edit_timeline', args: { op: 'fade', clip: target.id, in: sec, out: sec }, resultSummary: entry.changes.join('；') }],
      changed: true,
    };
  }

  // Pattern 3: color change (#hex or common Chinese color words)
  const colorMap: Record<string, string> = {
    红: '#ef4444', 橙: '#f97316', 黄: '#eab308', 绿: '#22c55e', 青: '#14b8a6', 蓝: '#3b82f6', 紫: '#a855f7', 粉: '#ec4899', 黑: '#111827',
  };
  const hexMatch = text.match(/#[0-9a-fA-F]{6}/);
  const zhColor = Object.entries(colorMap).find(([k]) => text.includes(k));
  if ((hexMatch || zhColor) && firstPage) {
    const color = hexMatch ? hexMatch[0].toLowerCase() : zhColor![1];
    const { entry } = commitProjectEdit(projectDir, [{ op: 'param', clip: firstPage.id, name: 'accent', value: color }], {
      why: `将 ${firstPage.id} 强调色调整为 ${color}`,
      author: 'agent',
    });
    onEditCommitted({ why: entry.why, changes: entry.changes, affectedClipIds: entry.affectedClipIds, focusTimeSec: entry.focusTimeSec });
    return {
      reply: `已将「${firstPage.id}」的强调色修改为 ${color}。`,
      toolTrace: [{ tool: 'edit_timeline', args: { op: 'param', clip: firstPage.id, name: 'accent', value: color }, resultSummary: entry.changes.join('；') }],
      changed: true,
    };
  }

  // Pattern 4: ducking BGM
  if (/压低|闪避|duck/i.test(text) && firstAudio) {
    const { entry } = commitProjectEdit(
      projectDir,
      [{ op: 'attr', clip: firstAudio.id, name: 'data-adudir-duck', value: '{"duckDb":-12,"attack":0.15,"release":0.35}' }],
      { why: `为 ${firstAudio.id} 开启人声闪避`, author: 'agent' },
    );
    onEditCommitted({ why: entry.why, changes: entry.changes, affectedClipIds: entry.affectedClipIds, focusTimeSec: entry.focusTimeSec });
    return {
      reply: `已为「${firstAudio.id}」启用自动闪避（人声出现时自动降低 12 dB）。`,
      toolTrace: [{ tool: 'edit_timeline', args: { op: 'attr', clip: firstAudio.id }, resultSummary: entry.changes.join('；') }],
      changed: true,
    };
  }

  return {
    reply:
      '当前未配置外部模型 API Key，本地快捷指令引擎支持：「把强调色改成紫色/#ff5500」、「在 1.5 秒处切开」、「添加 0.5 秒淡入淡出」、「开启自动闪避」；配置下方 API Key 后即可启用完整多轮工具调用与看图自检。',
    toolTrace: [],
    changed: false,
  };
}

/**
 * Run a multi-turn OpenAI-compatible tool-calling AI Director loop (with local rule fallback when no API key is given).
 */
export async function runAgentConversation(options: {
  projectDir: string;
  prompt: string;
  currentTime: number;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEditCommitted: (info: { why: string; changes: string[]; affectedClipIds?: string[]; focusTimeSec?: number }) => void;
}): Promise<AgentChatResult> {
  if (!options.apiKey?.trim()) {
    return runLocalRuleAgent(options.projectDir, options.prompt, options.currentTime, options.onEditCommitted);
  }

  const base = (options.apiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = options.model || 'gpt-4o-mini';
  const toolTrace: AgentToolTrace[] = [];
  let changed = false;

  const messages: OpenAiMessage[] = [
    {
      role: 'system',
      content: `你是 Open Director 剪辑导演助手。你可以通过工具直接读取工程、修改 composition.html（每次修改必须填 why）、并用 look_frames 查看渲染截图来验收自己的改动。请始终用中文向用户汇报你修改了什么、看了哪一秒的画面，避免暴露内部路径细节。当前播放头位于 ${options.currentTime.toFixed(2)} 秒。`,
    },
    ...(options.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: options.prompt },
  ];

  for (let turn = 0; turn < 6; turn += 1) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: 'auto',
      }),
    });

    const data = (await res.json()) as {
      error?: { message?: string };
      choices?: Array<{ message?: OpenAiMessage }>;
    };
    if (!res.ok || !data.choices?.[0]?.message) {
      throw new Error(data.error?.message || `LLM request failed (${res.status})`);
    }

    const msg = data.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        reply: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        toolTrace,
        changed,
      };
    }

    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {}
      const out = await executeAgentTool(options.projectDir, tc.function.name, args, options.onEditCommitted);
      if (out.changed) changed = true;
      toolTrace.push({ tool: tc.function.name, args, resultSummary: out.summary });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof out.content === 'string' ? out.content : JSON.stringify(out.content),
      });
    }
  }

  return {
    reply: '已完成多轮操作（已达最大工具调用轮次）。请查看时间线与历史记录确认效果。',
    toolTrace,
    changed,
  };
}
