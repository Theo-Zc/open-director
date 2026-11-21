import { getClipTimelineDuration, type CompositionClip, type CompositionDoc } from './composition.js';

function xmlEscape(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toRationalTime(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  const den = Math.round(fps * 100);
  const num = frames * 100;
  return `${num}/${den}s`;
}

/**
 * Export a `CompositionDoc` to a clean FCPXML 1.10 timeline document compatible with
 * Final Cut Pro and DaVinci Resolve.
 */
export function exportFcpxml(
  doc: CompositionDoc,
  options: {
    projectName?: string;
    fps?: number;
    intrinsicDurationsSec?: ReadonlyMap<string, number>;
  } = {},
): string {
  const fps = options.fps ?? (typeof doc.fps === 'number' ? doc.fps : 30);
  const projectName = options.projectName ?? 'Open Director Export';
  const intrinsic = options.intrinsicDurationsSec ?? new Map<string, number>();

  const assets = new Map<string, { id: string; src: string; durationSec: number; hasVideo: boolean; hasAudio: boolean }>();
  let assetCounter = 1;

  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!assets.has(clip.src)) {
        const dur = intrinsic.get(clip.src) ?? clip.outSec ?? 10;
        assets.set(clip.src, {
          id: `r${++assetCounter}`,
          src: clip.src,
          durationSec: dur,
          hasVideo: clip.kind !== 'audio',
          hasAudio: clip.kind === 'audio' || clip.kind === 'video',
        });
      }
    }
  }

  let totalDur = 0;
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const dur = getClipTimelineDuration(clip, intrinsic) ?? 5;
      totalDur = Math.max(totalDur, clip.at + dur);
    }
  }

  const assetLines = [...assets.values()].map(
    (a) =>
      `    <asset id="${a.id}" name="${xmlEscape(a.src)}" src="file://./${xmlEscape(a.src)}" duration="${toRationalTime(a.durationSec, fps)}" hasVideo="${a.hasVideo ? 1 : 0}" hasAudio="${a.hasAudio ? 1 : 0}" format="r1" />`,
  );

  const spineClips: string[] = [];
  const laneEntries: string[] = [];

  // Primary spine uses bottom-most non-hidden visual track (or first non-hidden track)
  const visibleTracks = doc.tracks
    .map((t, idx) => ({ track: t, idx }))
    .filter((x) => !x.track.hidden);

  const primaryIdx = visibleTracks.length > 0 ? visibleTracks[visibleTracks.length - 1].idx : -1;

  const renderClipXml = (clip: CompositionClip, laneAttr: string): string => {
    const asset = assets.get(clip.src)!;
    const dur = getClipTimelineDuration(clip, intrinsic) ?? 5;
    const tag = clip.kind === 'audio' ? 'asset-clip' : 'asset-clip';
    const gainDb = clip.muted || clip.volume <= 0 ? -96 : 20 * Math.log10(clip.volume);
    return `            <${tag} ref="${asset.id}"${laneAttr} name="${xmlEscape(clip.id)}" offset="${toRationalTime(clip.at, fps)}" start="${toRationalTime(clip.inSec, fps)}" duration="${toRationalTime(dur, fps)}">
              ${clip.kind === 'audio' || clip.kind === 'video' ? `<adjust-volume amount="${gainDb.toFixed(2)}dB" />` : ''}
            </${tag}>`;
  };

  for (const { track, idx } of visibleTracks) {
    const sorted = [...track.clips].sort((a, b) => a.at - b.at);
    if (idx === primaryIdx) {
      for (const clip of sorted) {
        spineClips.push(renderClipXml(clip, ''));
      }
    } else {
      const laneNum = primaryIdx - idx;
      for (const clip of sorted) {
        laneEntries.push(renderClipXml(clip, ` lane="${laneNum}"`));
      }
    }
  }

  // Attach secondary lanes cleanly inside first spine clip or a gap container
  const spineContent =
    spineClips.length > 0
      ? [
          spineClips[0].replace(
            '</asset-clip>',
            `${laneEntries.length > 0 ? '\n' + laneEntries.join('\n') : ''}\n            </asset-clip>`,
          ),
          ...spineClips.slice(1),
        ].join('\n')
      : `            <gap name="Gap" offset="0/1s" duration="${toRationalTime(Math.max(1, totalDur), fps)}">\n${laneEntries.join('\n')}\n            </gap>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${doc.viewport.height}p${Math.round(fps)}" frameDuration="${toRationalTime(1 / fps, fps)}" width="${doc.viewport.width}" height="${doc.viewport.height}" />
${assetLines.join('\n')}
  </resources>
  <library>
    <event name="${xmlEscape(projectName)}">
      <project name="${xmlEscape(projectName)}">
        <sequence format="r1" duration="${toRationalTime(totalDur, fps)}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineContent}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
