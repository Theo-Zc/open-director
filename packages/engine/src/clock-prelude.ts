export interface ClockPreludeConfig {
  cues?: Record<string, number | undefined>;
  lines?: Record<string, { at: number; end: number; text: string; chars: Array<{ c: string; at: number | null }> }>;
}

/**
 * Generates the deterministic `window.filmHost` clock & override prelude injected
 * before any page script executes.
 */
export function buildFilmClockPrelude(config: ClockPreludeConfig = {}): string {
  const cuesJson = JSON.stringify(config.cues ?? {});
  const linesJson = JSON.stringify(config.lines ?? {});

  return `(() => {
  if (window.filmHost) return;
  const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  const cues = ${cuesJson};
  const lines = ${linesJson};

  const realPerfNow = performance.now.bind(performance);
  const RealDate = Date;
  const realRandom = Math.random.bind(Math);
  const realRAF = window.requestAnimationFrame.bind(window);
  const realCAF = window.cancelAnimationFrame.bind(window);

  let pinned = false;
  let currentSec = 0;
  let rngState = 0x12345678;

  function seedFromTime(t) {
    const quantized = Math.round(t * 1000000);
    return (quantized ^ 0x9e3779b9) >>> 0;
  }

  function nextRandom() {
    if (!pinned) return realRandom();
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let z = rngState;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  performance.now = () => (pinned ? currentSec * 1000 : realPerfNow());

  class DeterministicDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && pinned) {
        super(EPOCH_MS + currentSec * 1000);
      } else {
        super(...args);
      }
    }
    static now() {
      return pinned ? EPOCH_MS + currentSec * 1000 : RealDate.now();
    }
  }
  window.Date = DeterministicDate;
  Math.random = nextRandom;

  // Under host control, prevent pages from running free-wheeling rAF loops
  let rafSeq = 1;
  window.requestAnimationFrame = () => rafSeq++;
  window.cancelAnimationFrame = () => {};

  function applyTextOverride(el, text) {
    const linesArr = String(text).split('\\n');
    const children = [...el.childNodes];
    const hasOnlyTextOrBr = children.every((n) => n.nodeType === 3 || (n.nodeType === 1 && n.tagName === 'BR'));
    if (hasOnlyTextOrBr || children.length === 0) {
      el.replaceChildren();
      linesArr.forEach((line, idx) => {
        if (idx > 0) el.appendChild(document.createElement('br'));
        el.appendChild(document.createTextNode(line));
      });
      return;
    }
    const firstText = children.find((n) => n.nodeType === 3 && n.textContent.trim().length > 0) ?? children.find((n) => n.nodeType === 3);
    if (firstText) {
      firstText.textContent = text;
    } else {
      el.insertBefore(document.createTextNode(text), el.firstChild);
    }
  }

  function applyOverrides(overrides) {
    if (!Array.isArray(overrides)) return;
    for (const entry of overrides) {
      if (!entry || typeof entry !== 'object' || !entry.at) continue;
      let matches;
      try {
        matches = [...document.querySelectorAll(entry.at)];
      } catch {
        continue;
      }
      if (matches.length === 0) continue;
      const targets = typeof entry.n === 'number' ? (matches[entry.n - 1] ? [matches[entry.n - 1]] : []) : matches;
      for (const el of targets) {
        if (entry.style && typeof entry.style === 'object') {
          for (const [k, v] of Object.entries(entry.style)) {
            if (k.startsWith('--')) {
              el.style.setProperty(k, String(v));
            } else {
              el.style.setProperty(k, String(v), 'important');
            }
          }
        }
        if (Array.isArray(entry.t) && entry.t.length === 2) {
          el.style.translate = entry.t[0] + 'px ' + entry.t[1] + 'px';
        }
        if (entry.s !== undefined) {
          if (Array.isArray(entry.s)) {
            el.style.scale = entry.s[0] + ' ' + entry.s[1];
          } else {
            el.style.scale = String(entry.s);
          }
        }
        if (typeof entry.r === 'number') {
          el.style.rotate = entry.r + 'deg';
        }
        if (typeof entry.text === 'string') {
          applyTextOverride(el, entry.text);
        }
      }
    }
  }

  function settleAnimations(t) {
    if (typeof document.getAnimations !== 'function') return;
    const ms = t * 1000;
    for (const anim of document.getAnimations({ subtree: true })) {
      try {
        if (anim instanceof CSSTransition) {
          anim.finish();
        } else {
          anim.pause();
          anim.currentTime = ms;
        }
      } catch {}
    }
  }

  window.filmHost = {
    version: '0.1',
    name: 'open-director',
    time(t) {
      pinned = true;
      currentSec = t;
      rngState = seedFromTime(t);
    },
    settle(t) {
      settleAnimations(t);
    },
    cue(name) {
      return cues[name];
    },
    line(clipId) {
      return lines[clipId];
    },
    applyOverrides,
    _realRAF: realRAF,
    _realCAF: realCAF,
  };
})();`;
}
