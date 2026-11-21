import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SfxCatalogItem {
  id: string;
  title: string;
  title_en: string;
  category: 'whoosh' | 'pop' | 'ui' | 'chime' | 'impact';
  tags: string[];
  description: string;
  use_for: string[];
  duration_sec: number;
  quality: number;
  family: string;
}

export const BUILTIN_SFX_CATALOG: SfxCatalogItem[] = [
  {
    id: 'pop_soft',
    title: '柔和气泡弹出',
    title_en: 'Soft Bubble Pop',
    category: 'pop',
    tags: ['pop', 'bubble', '弹出', '气泡', '卡片'],
    description: '轻柔清脆的弹出音，适合卡片或角标出现',
    use_for: ['卡片出现', '气泡弹出', '文字亮起'],
    duration_sec: 0.16,
    quality: 3,
    family: 'pop',
  },
  {
    id: 'pop_tight',
    title: '清脆短促点击',
    title_en: 'Tight Pop',
    category: 'pop',
    tags: ['pop', 'tight', '点击', '轻弹', '标签'],
    description: '极短促的清脆弹出音效，适合高频微动效',
    use_for: ['列表依次出现', '按钮高亮'],
    duration_sec: 0.1,
    quality: 3,
    family: 'pop',
  },
  {
    id: 'click_glass',
    title: '玻璃轻敲',
    title_en: 'Glass Click',
    category: 'ui',
    tags: ['click', 'glass', 'ui', '玻璃', '轻敲', '切换'],
    description: '清亮的玻璃质感界面提示音',
    use_for: ['开关切换', '光标点击'],
    duration_sec: 0.12,
    quality: 3,
    family: 'click',
  },
  {
    id: 'whoosh_short',
    title: '短促划过',
    title_en: 'Short Whoosh',
    category: 'whoosh',
    tags: ['whoosh', 'swipe', 'transition', '转场', '划过', '飞入'],
    description: '紧凑空气感扫过声，适合卡片飞入或转场',
    use_for: ['卡片飞入', '镜头切换', '文字滑入'],
    duration_sec: 0.32,
    quality: 3,
    family: 'whoosh',
  },
  {
    id: 'whoosh_long',
    title: '长距转场风声',
    title_en: 'Long Whoosh',
    category: 'whoosh',
    tags: ['whoosh', 'sweep', 'air', '长转场', '风声', '拉开'],
    description: '柔和拉长的空气 sweep，适合章节过渡',
    use_for: ['章节切换', '透视拉远'],
    duration_sec: 0.65,
    quality: 3,
    family: 'whoosh',
  },
  {
    id: 'chime_high',
    title: '清亮高音提示',
    title_en: 'High Chime',
    category: 'chime',
    tags: ['chime', 'bell', 'ding', '提示', '叮', '结论'],
    description: '干净悦耳的高频金属共鸣，适合重点结论揭示',
    use_for: ['得出结论', '数字定格', '关键词强调'],
    duration_sec: 0.55,
    quality: 3,
    family: 'chime',
  },
  {
    id: 'chime_low',
    title: '沉稳钟鸣',
    title_en: 'Low Bell Chime',
    category: 'chime',
    tags: ['bell', 'low', 'chime', '钟声', '沉稳', '开场'],
    description: '温润低沉的钟鸣声，适合开场定调',
    use_for: ['片头落版', '章节标题'],
    duration_sec: 0.9,
    quality: 3,
    family: 'chime',
  },
  {
    id: 'kick_thud',
    title: '沉重盖章顿挫',
    title_en: 'Heavy Stamp Thud',
    category: 'impact',
    tags: ['impact', 'thud', 'slam', '门', '砰', '盖章', '重击'],
    description: '低频有力的落地撞击声，适合盖章、重物落下',
    use_for: ['盖章落定', '标题砸入', '门砰地关上'],
    duration_sec: 0.28,
    quality: 3,
    family: 'impact',
  },
  {
    id: 'sparkle',
    title: '微光闪耀',
    title_en: 'Sparkle Shimmer',
    category: 'chime',
    tags: ['sparkle', 'magic', 'shimmer', '闪烁', '高亮', '星光'],
    description: '细腻的泛音闪烁，适合数据亮起或徽章解锁',
    use_for: ['亮点标注', '成就解锁'],
    duration_sec: 0.6,
    quality: 3,
    family: 'sparkle',
  },
  {
    id: 'tap_wood',
    title: '木质轻敲',
    title_en: 'Wood Tap',
    category: 'ui',
    tags: ['tap', 'wood', 'tick', '木头', '节拍', '打字'],
    description: '温暖干脆的木质敲击声',
    use_for: ['打字机步进', '步骤切换'],
    duration_sec: 0.09,
    quality: 3,
    family: 'tap',
  },
];

function encodePcm16StereoWav(samplesL: Float32Array, samplesR: Float32Array, sampleRate = 44100): Buffer {
  const numSamples = samplesL.length;
  const dataSize = numSamples * 4; // 2 channels * 2 bytes
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const l = Math.max(-1, Math.min(1, samplesL[i]));
    const r = Math.max(-1, Math.min(1, samplesR[i]));
    buf.writeInt16LE(Math.round(l * 32767), offset);
    buf.writeInt16LE(Math.round(r * 32767), offset + 2);
    offset += 4;
  }
  return buf;
}

function deterministicNoise(index: number): number {
  let x = (index ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (((x ^ (x >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Procedurally synthesize a deterministic, royalty-free stereo WAV buffer for any built-in SFX id.
 */
export function synthesizeBuiltinSfxWav(id: string): Buffer | null {
  const item = BUILTIN_SFX_CATALOG.find((s) => s.id === id);
  if (!item) return null;

  const sr = 44100;
  const n = Math.max(1, Math.round(item.duration_sec * sr));
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const u = i / n;
    let val = 0;

    switch (id) {
      case 'pop_soft': {
        const freq = 320 + 520 * u;
        val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 26) * 0.55;
        break;
      }
      case 'pop_tight': {
        const freq = 520 + 720 * u;
        val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 42) * 0.55;
        break;
      }
      case 'click_glass': {
        const env = Math.exp(-t * 48);
        val = (Math.sin(2 * Math.PI * 1950 * t) * 0.5 + Math.sin(2 * Math.PI * 3120 * t) * 0.3) * env * 0.5;
        break;
      }
      case 'whoosh_short':
      case 'whoosh_long': {
        const env = Math.sin(Math.PI * u) ** 1.6;
        const lpPrev = i > 0 ? L[i - 1] : 0;
        const raw = deterministicNoise(i) * 0.35 + Math.sin(2 * Math.PI * (140 + 260 * Math.sin(Math.PI * u)) * t) * 0.12;
        val = (lpPrev * 0.72 + raw * 0.28) * env * 0.7;
        break;
      }
      case 'chime_high': {
        const env = Math.exp(-t * 6.5);
        val =
          (Math.sin(2 * Math.PI * 1046.5 * t) * 0.55 +
            Math.sin(2 * Math.PI * 1567.98 * t) * 0.25 +
            Math.sin(2 * Math.PI * 2093.0 * t) * 0.15) *
          env *
          0.55;
        break;
      }
      case 'chime_low': {
        const env = Math.exp(-t * 4.2);
        val =
          (Math.sin(2 * Math.PI * 392.0 * t) * 0.6 +
            Math.sin(2 * Math.PI * 784.0 * t) * 0.25 +
            Math.sin(2 * Math.PI * 1174.66 * t) * 0.1) *
          env *
          0.55;
        break;
      }
      case 'kick_thud': {
        const freq = 155 * Math.exp(-t * 14) + 42;
        const env = Math.exp(-t * 15);
        val = (Math.sin(2 * Math.PI * freq * t) * 0.8 + deterministicNoise(i) * Math.exp(-t * 65) * 0.25) * env * 0.75;
        break;
      }
      case 'sparkle': {
        const env = Math.sin(Math.PI * u) * Math.exp(-t * 3.0);
        val =
          (Math.sin(2 * Math.PI * 1760 * t) * 0.3 +
            Math.sin(2 * Math.PI * 2637 * t) * 0.3 +
            Math.sin(2 * Math.PI * 3520 * t) * 0.25) *
          env *
          0.5;
        break;
      }
      case 'tap_wood': {
        const env = Math.exp(-t * 58);
        val = (Math.sin(2 * Math.PI * 760 * t) * 0.6 + Math.sin(2 * Math.PI * 1240 * t) * 0.3) * env * 0.6;
        break;
      }
    }

    L[i] = val;
    R[i] = val;
  }

  return encodePcm16StereoWav(L, R, sr);
}

const SFX_CACHE_DIR = join(tmpdir(), 'open-director-sfx-cache');

/**
 * Ensure a built-in SFX WAV exists on disk so FFmpeg can read it directly during export.
 */
export function ensureBuiltinSfxFile(id: string): string | null {
  const wav = synthesizeBuiltinSfxWav(id);
  if (!wav) return null;
  mkdirSync(SFX_CACHE_DIR, { recursive: true });
  const filePath = join(SFX_CACHE_DIR, `${id}.wav`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, wav);
  }
  return filePath;
}
