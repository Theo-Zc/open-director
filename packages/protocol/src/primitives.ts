/**
 * Clean-room motion primitives ESM runtime served at `/__film/motion-primitives.mjs`
 * so pages share deterministic easing, springs, staggers, and PRNG helpers.
 */
export const MOTION_PRIMITIVES_SOURCE = `// @open-director/protocol — __film/motion-primitives.mjs
export function clamp(x, min = 0, max = 1) {
  return Math.min(max, Math.max(min, x));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, v) {
  if (a === b) return 0;
  return clamp((v - a) / (b - a), 0, 1);
}

export function remap(inMin, inMax, outMin, outMax, v) {
  return lerp(outMin, outMax, invLerp(inMin, inMax, v));
}

export function smoothstep(edge0, edge1, x) {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

export const ease = {
  linear: (t) => clamp(t),
  inQuad: (t) => { const x = clamp(t); return x * x; },
  outQuad: (t) => { const x = clamp(t); return 1 - (1 - x) * (1 - x); },
  inOutQuad: (t) => { const x = clamp(t); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; },
  outCubic: (t) => 1 - Math.pow(1 - clamp(t), 3),
  inOutCubic: (t) => { const x = clamp(t); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
  outQuart: (t) => 1 - Math.pow(1 - clamp(t), 4),
  outExpo: (t) => { const x = clamp(t); return x === 1 ? 1 : 1 - Math.pow(2, -10 * x); },
  outBack: (t, s = 1.70158) => {
    const x = clamp(t) - 1;
    return 1 + (s + 1) * x * x * x + s * x * x;
  },
};

/**
 * Analytical critically/under-damped spring evaluator strictly as a function of t (seconds).
 */
export function spring(t, { stiffness = 180, damping = 18, mass = 1, from = 0, to = 1 } = {}) {
  if (t <= 0) return from;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let progress;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    progress = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  } else if (Math.abs(zeta - 1) < 1e-5) {
    progress = 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  } else {
    const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
    progress = 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
  }
  return lerp(from, to, progress);
}

export function stagger(t, index, { start = 0, step = 0.08, duration = 0.45 } = {}) {
  return invLerp(start + index * step, start + index * step + duration, t);
}

export function countUp(t, start, end, fromValue, toValue, easingFn = ease.outCubic) {
  const p = easingFn(invLerp(start, end, t));
  return lerp(fromValue, toValue, p);
}

export function seededRandom(seed) {
  let s = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}
`;
