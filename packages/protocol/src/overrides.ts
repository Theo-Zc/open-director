import { z } from 'zod';

export const PARAM_NAME_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const PARAM_DECL_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('color'),
    default: z.string().regex(HEX_COLOR_RE, 'Expected hex color (#rgb, #rgba, #rrggbb, #rrggbbaa)'),
    label: z.string().optional(),
    group: z.string().optional(),
    hint: z.string().optional(),
  }),
  z.object({
    type: z.literal('number'),
    default: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().positive().optional(),
    unit: z.string().optional(),
    label: z.string().optional(),
    group: z.string().optional(),
    hint: z.string().optional(),
  }),
  z.object({
    type: z.literal('text'),
    default: z.string().max(2000),
    maxLength: z.number().int().positive().max(2000).optional(),
    multiline: z.boolean().optional(),
    label: z.string().optional(),
    group: z.string().optional(),
    hint: z.string().optional(),
  }),
  z.object({
    type: z.literal('toggle'),
    default: z.boolean(),
    label: z.string().optional(),
    group: z.string().optional(),
    hint: z.string().optional(),
  }),
]);

export type ParamDecl = z.infer<typeof PARAM_DECL_SCHEMA>;
export type ParamValue = string | number | boolean;

export const ELEMENT_OVERRIDE_SCHEMA = z.object({
  at: z.string().min(1),
  n: z.number().int().positive().optional(),
  t: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  s: z.union([z.number().finite(), z.tuple([z.number().finite(), z.number().finite()])]).optional(),
  r: z.number().finite().optional(),
  style: z.record(z.string()).optional(),
  text: z.string().optional(),
  lock: z.boolean().optional(),
});

export const CLIP_FADE_OVERRIDE_SCHEMA = z.object({
  fade: z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
});

export const CLIP_OVERRIDE_SCHEMA = z.union([ELEMENT_OVERRIDE_SCHEMA, CLIP_FADE_OVERRIDE_SCHEMA]);

export type ElementOverride = z.infer<typeof ELEMENT_OVERRIDE_SCHEMA>;
export type ClipFadeOverride = z.infer<typeof CLIP_FADE_OVERRIDE_SCHEMA>;
export type ClipOverride = z.infer<typeof CLIP_OVERRIDE_SCHEMA>;

export function isFadeOverride(entry: ClipOverride): entry is ClipFadeOverride {
  return 'fade' in entry && !('at' in entry);
}

export function isElementOverride(entry: ClipOverride): entry is ElementOverride {
  return 'at' in entry;
}

export function parseOverrides(raw: string | undefined): ClipOverride[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid overrides JSON: ${(err as Error).message}`);
  }
  return z.array(CLIP_OVERRIDE_SCHEMA).parse(parsed);
}

export function serializeOverrides(overrides: ClipOverride[]): string | undefined {
  if (overrides.length === 0) return undefined;
  return JSON.stringify(overrides);
}

/**
 * Validate and encode a parameter value into its CSS custom property literal.
 */
export function encodeParam(decl: ParamDecl, value: unknown): string {
  switch (decl.type) {
    case 'color': {
      if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) {
        throw new Error(`Expected hex color value, got ${JSON.stringify(value)}`);
      }
      return value.toLowerCase();
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw new Error(`Expected finite number, got ${JSON.stringify(value)}`);
      }
      const lo = decl.min ?? -Infinity;
      const hi = decl.max ?? Infinity;
      const clamped = Math.min(hi, Math.max(lo, n));
      return String(clamped);
    }
    case 'toggle': {
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (value === 1 || value === '1' || value === 'true') return '1';
      if (value === 0 || value === '0' || value === 'false') return '0';
      throw new Error(`Expected boolean toggle value, got ${JSON.stringify(value)}`);
    }
    case 'text': {
      if (typeof value !== 'string') {
        throw new Error(`Expected string text value, got ${JSON.stringify(value)}`);
      }
      const limit = decl.maxLength ?? 2000;
      const text = decl.multiline ? value : value.replace(/\r?\n/g, ' ');
      return JSON.stringify(text.slice(0, limit));
    }
  }
}

/**
 * Decode a CSS custom property literal back into a typed JS value.
 */
export function decodeParam(decl: ParamDecl, cssLiteral: string | undefined): ParamValue {
  if (cssLiteral === undefined || cssLiteral.trim() === '') return decl.default;
  const trimmed = cssLiteral.trim();
  switch (decl.type) {
    case 'color':
      return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : decl.default;
    case 'number': {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return decl.default;
      const lo = decl.min ?? -Infinity;
      const hi = decl.max ?? Infinity;
      return Math.min(hi, Math.max(lo, n));
    }
    case 'toggle':
      return trimmed === '1' || trimmed === 'true';
    case 'text': {
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === 'string') return parsed;
        } catch {
          // fall through to unquoted string
        }
      }
      return trimmed;
    }
  }
}

export function readRootParamsFromOverrides(overrides: ClipOverride[]): Record<string, string> {
  const root = overrides.find((o): o is ElementOverride => isElementOverride(o) && o.at === ':root');
  if (!root?.style) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.style)) {
    if (k.startsWith('--')) result[k.slice(2)] = v;
  }
  return result;
}

export function setRootParamInOverrides(
  overrides: ClipOverride[],
  name: string,
  encodedValue: string | null,
): ClipOverride[] {
  if (!PARAM_NAME_RE.test(name)) {
    throw new Error(`Invalid parameter name "${name}"`);
  }
  const prop = `--${name}`;
  const next = overrides.map((entry) => ({ ...entry }));
  const rootIdx = next.findIndex((o): o is ElementOverride => isElementOverride(o) && o.at === ':root');

  if (encodedValue === null) {
    if (rootIdx === -1) return next;
    const root = { ...(next[rootIdx] as ElementOverride) };
    const style = { ...(root.style ?? {}) };
    delete style[prop];
    if (Object.keys(style).length === 0) {
      delete root.style;
    } else {
      root.style = style;
    }
    const hasOther =
      root.n !== undefined ||
      root.t !== undefined ||
      root.s !== undefined ||
      root.r !== undefined ||
      root.text !== undefined ||
      root.lock !== undefined ||
      root.style !== undefined;
    if (!hasOther) {
      next.splice(rootIdx, 1);
    } else {
      next[rootIdx] = root;
    }
    return next;
  }

  if (rootIdx === -1) {
    next.push({ at: ':root', style: { [prop]: encodedValue } });
  } else {
    const root = { ...(next[rootIdx] as ElementOverride) };
    root.style = { ...(root.style ?? {}), [prop]: encodedValue };
    next[rootIdx] = root;
  }
  return next;
}

/**
 * Browser-side ESM runtime served at `/__film/film-params.mjs` alongside any page.
 */
export const FILM_PARAMS_RUNTIME_SOURCE = `// @open-director/protocol — __film/film-params.mjs
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function readParamDecl(film) {
  const raw = film && typeof film === 'object' ? film.params : null;
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [name, decl] of Object.entries(raw)) {
    if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(name) || !decl || typeof decl !== 'object') continue;
    if (!['color', 'number', 'text', 'toggle'].includes(decl.type) || decl.default === undefined) continue;
    out[name] = { ...decl };
  }
  return out;
}

export function encodeParam(decl, value) {
  if (decl.type === 'color') return String(value).toLowerCase();
  if (decl.type === 'number') {
    const n = Number(value);
    const lo = typeof decl.min === 'number' ? decl.min : -Infinity;
    const hi = typeof decl.max === 'number' ? decl.max : Infinity;
    return String(Math.min(hi, Math.max(lo, n)));
  }
  if (decl.type === 'toggle') return value ? '1' : '0';
  return JSON.stringify(String(value));
}

export function decodeParam(decl, literal) {
  if (literal == null || String(literal).trim() === '') return decl.default;
  const trimmed = String(literal).trim();
  if (decl.type === 'color') return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : decl.default;
  if (decl.type === 'number') {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return decl.default;
    const lo = typeof decl.min === 'number' ? decl.min : -Infinity;
    const hi = typeof decl.max === 'number' ? decl.max : Infinity;
    return Math.min(hi, Math.max(lo, n));
  }
  if (decl.type === 'toggle') return trimmed === '1' || trimmed === 'true';
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return trimmed;
}

export function useParams(film) {
  const decls = readParamDecl(film);
  const root = document.documentElement;
  const lastValues = {};
  for (const [name, decl] of Object.entries(decls)) {
    const prop = '--' + name;
    const existing = root.style.getPropertyValue(prop).trim();
    if (!existing) {
      root.style.setProperty(prop, encodeParam(decl, decl.default));
    }
    lastValues[name] = decodeParam(decl, root.style.getPropertyValue(prop));
  }

  const observer = new MutationObserver(() => {
    const changed = [];
    for (const [name, decl] of Object.entries(decls)) {
      const next = decodeParam(decl, root.style.getPropertyValue('--' + name));
      if (next !== lastValues[name]) {
        lastValues[name] = next;
        changed.push(name);
      }
    }
    if (changed.length > 0) {
      window.dispatchEvent(new CustomEvent('filmparamchange', { detail: { changed } }));
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ['style'] });

  return function param(name) {
    const decl = decls[name];
    if (!decl) return undefined;
    return decodeParam(decl, root.style.getPropertyValue('--' + name));
  };
}
`;
