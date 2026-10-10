/** Independently specified media timeline; values arrive only after schema/ownership checks. */
export interface CampfireSegment {
  assetId: string;
  startSeconds: number;
  durationSeconds: number;
  caption?: string;
  framing?: "blur" | "crop" | "contain";
  cropX?: number;
  cropY?: number;
  motion?: "none" | "push-in";
}
export interface CampfireAudio {
  narrationId?: string;
  musicId?: string;
  sourceVolume?: number;
  musicVolume?: number;
}
export interface CampfireArtText {
  text: string;
  startSeconds: number;
  durationSeconds: number;
  style: "warm" | "fresh" | "gold";
  position: "top" | "center";
}
export interface CampfireCaption { startSeconds: number; durationSeconds: number; text: string }
export function campfireDimensions(aspectRatio: string): [number, number] {
  return aspectRatio === "16:9" ? [1920, 1080] : aspectRatio === "1:1" ? [1080, 1080] : [1080, 1920];
}
export function campfireVideoFilter(segment: CampfireSegment, width: number, height: number): string {
  const size = `${width}:${height}`;
  let filter: string;
  if (segment.framing === "crop") {
    filter = `[0:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size}:(iw-ow)*${segment.cropX ?? 0.5}:(ih-oh)*${segment.cropY ?? 0.5}`;
  } else if (segment.framing === "contain") {
    filter = `[0:v]scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black`;
  } else {
    filter = `[0:v]split=2[background][foreground];[background]scale=${size}:force_original_aspect_ratio=increase,crop=${size},gblur=sigma=24[blurred];[foreground]scale=${size}:force_original_aspect_ratio=decrease[sharp];[blurred][sharp]overlay=(W-w)/2:(H-h)/2`;
  }
  if (segment.motion === "push-in") {
    // Frame-based progress applies equally to moving footage and looped images.
    const lastFrame = Math.max(1, Math.ceil(segment.durationSeconds * 30) - 1);
    filter += `,fps=30,zoompan=z='min(1+0.08*on/${lastFrame},1.08)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`;
  }
  return `${filter},setsar=1,fps=30,format=yuv420p[video]`;
}
function timestamp(seconds: number): string {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
export function campfireCaptions(segments: CampfireSegment[], width: number, height: number, narrationCaptions?: CampfireCaption[], generatedIndices: readonly number[] = [], artText: readonly CampfireArtText[] = []): string {
  const portrait = height > width;
  const fontSize = portrait ? 58 : 48;
  const lineLength = portrait ? 16 : 28;
  const artSize = portrait ? 96 : 88;
  const artStyles = [
    ["warm", "&H0048E8FF", "&H00243A85", 7, 4],
    ["fresh", "&H00FFFFFF", "&H00B85E20", 6, 3],
    ["gold", "&H0066D9F5", "&H001A1823", 5, 5],
  ].map(([name, color, outline, border, shadow]) => `Style: Art_${name},Noto Sans CJK SC,${artSize},${color},${color},${outline},&H80000000,-1,0,0,0,100,100,2,0,1,${border},${shadow},5,80,80,80,1`).join("\n");
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,70,70,${portrait ? 160 : 80},1\n${artStyles}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const cues: string[] = [];
  const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  let elapsed = 0;
  const segmentTimeline = segments.map(segment => { const cue = { startSeconds: elapsed, durationSeconds: segment.durationSeconds, text: segment.caption ?? "" }; elapsed += segment.durationSeconds; return cue; });
  const timeline: CampfireCaption[] = narrationCaptions?.length ? [...narrationCaptions] : segmentTimeline;
  if (narrationCaptions?.length) {
    const spoken = new Set(narrationCaptions.map(cue => cue.text.trim()));
    for (const cue of segmentTimeline) {
      if (!cue.text.trim() || spoken.has(cue.text.trim())) continue;
      let gaps = [{ start: cue.startSeconds, end: cue.startSeconds + cue.durationSeconds }];
      for (const speech of narrationCaptions) {
        const speechEnd = speech.startSeconds + speech.durationSeconds;
        gaps = gaps.flatMap(gap => {
          if (speechEnd <= gap.start || speech.startSeconds >= gap.end) return [gap];
          return [
            ...(speech.startSeconds > gap.start ? [{ start: gap.start, end: speech.startSeconds }] : []),
            ...(speechEnd < gap.end ? [{ start: speechEnd, end: gap.end }] : []),
          ];
        });
      }
      // Show unvoiced labels such as an outro only where measured speech captions are absent.
      timeline.push(...gaps.map(gap => ({ startSeconds: gap.start, durationSeconds: gap.end - gap.start, text: cue.text })));
    }
    timeline.sort((left, right) => left.startSeconds - right.startSeconds);
  }
  for (const cue of timeline) {
    const chars = [...cue.text].map(char => /[\p{Cc}{}\\<>]/u.test(char) ? " " : char).join("").trim();
    const all = [...chars];
    let boundary = 0;
    const wordEnds = [...wordSegmenter.segment(chars)].map(part => { boundary += [...part.segment].length; return boundary; });
    const lines: string[] = [];
    for (let index = 0; index < all.length;) {
      let end = Math.min(index + lineLength, all.length);
      // Prefer a complete word, keeping long unbroken tokens bounded by the existing width.
      if (end < all.length) {
        const wordEnd = wordEnds.findLast(value => value > index && value <= end &&
          !/[，。！？；：、,.!?;:）】》」』”’]/u.test(all[value] ?? "") &&
          !/[（【《「『“‘]/u.test(all[value - 1] ?? ""));
        if (wordEnd !== undefined && wordEnd - index >= Math.ceil(lineLength / 2)) end = wordEnd;
      }
      // Avoid stranded Chinese punctuation without exceeding the caption width.
      while (end > index + 1 && end < all.length &&
        (/[，。！？；：、,.!?;:）】》」』”’]/u.test(all[end]!) || /[（【《「『“‘]/u.test(all[end - 1]!))) end--;
      lines.push(all.slice(index, end).join(""));
      index = end;
    }
    const pages: string[] = [];
    for (let index = 0; index < lines.length; index += 2) pages.push(lines.slice(index, index + 2).join("\\N"));
    pages.forEach((page, index) => cues.push(`Dialogue: 0,${timestamp(cue.startSeconds + cue.durationSeconds * index / pages.length)},${timestamp(cue.startSeconds + cue.durationSeconds * (index + 1) / pages.length)},Default,,0,0,0,,${page}`));
  }
  let segmentStart = 0;
  for (const [index, segment] of segments.entries()) {
    if (generatedIndices.includes(index)) cues.push(`Dialogue: 1,${timestamp(segmentStart)},${timestamp(segmentStart + segment.durationSeconds)},Default,,0,0,0,,{\\an9\\pos(${width - 48},48)\\fs${portrait ? 36 : 30}}AI 演绎`);
    segmentStart += segment.durationSeconds;
  }
  for (const title of artText) {
    const chars = [...title.text].map(char => /[\p{Cc}{}\\<>]/u.test(char) ? " " : char).join("").trim();
    if (!chars) continue;
    const letters = [...chars];
    const limit = portrait ? 12 : 18;
    const lines: string[] = [];
    for (let index = 0; index < letters.length; index += limit) lines.push(letters.slice(index, index + limit).join(""));
    // Reserve side room for ornaments and rotation, including long and multiline titles.
    const scale = Math.min(width, height) / 1080;
    const longest = Math.max(...lines.map(line => [...line].length));
    const size = Math.round(Math.min(artSize, width * 0.66 / longest));
    const x = Math.round(width / 2);
    const y = Math.round(height * (title.position === "top" ? 0.22 : 0.45));
    const fill = title.style === "fresh" ? "&H00FFFFFF&" : title.style === "gold" ? "&H0038E8FF&" : "&H0048AEFF&";
    const rim = title.style === "fresh" ? "&H00B85E20&" : "&H002875C8&";
    const start = timestamp(title.startSeconds), end = timestamp(title.startSeconds + title.durationSeconds);
    const layers = [
      { layer: 2, dx: 7, dy: 12, color: "&H00202532&", border: "&H00202532&", outline: 15 },
      { layer: 3, dx: 3, dy: 6, color: rim, border: rim, outline: 12 },
      { layer: 4, dx: 0, dy: 0, color: "&H00FFFFFF&", border: "&H00FFFFFF&", outline: 10 },
      { layer: 5, dx: 0, dy: 0, color: fill, border: "&H00202532&", outline: 4 },
    ];
    for (const layer of layers) {
      const px = Math.round(x + layer.dx * scale), py = Math.round(y + layer.dy * scale);
      const tags = `{\\an5\\fs${size}\\b1\\move(${px},${Math.round(py + 28 * scale)},${px},${py},0,170)\\org(${x},${y})\\frz-4\\fax0.08\\1c${layer.color}\\3c${layer.border}\\bord${layer.outline * scale}\\shad0\\fscx58\\fscy58\\t(0,150,\\fscx110\\fscy110)\\t(150,260,\\fscx100\\fscy100)\\fad(70,160)}`;
      cues.push(`Dialogue: ${layer.layer},${start},${end},Art_${title.style},,0,0,0,,${tags}${lines.join("\\N")}`);
    }
    const halfWidth = longest * size / 2;
    for (const [side, offsetY, rotation, ornamentSize] of [[-1, -30, 12, 1], [1, 30, -12, 0.8]] as const) {
      const px = Math.round(x + side * (halfWidth + 48 * scale));
      const py = Math.round(y + offsetY * scale);
      // Vector ornaments render without a Unicode star glyph or an external image dependency.
      const growth = Math.round(100 * scale * ornamentSize);
      const tags = `{\\an7\\pos(${px},${py})\\p1\\frz${rotation}\\1c${fill}\\3c&H00FFFFFF&\\bord${3 * scale}\\shad0\\fscx0\\fscy0\\t(90,240,\\fscx${growth}\\fscy${growth})\\fad(90,160)}`;
      cues.push(`Dialogue: 6,${start},${end},Art_${title.style},,0,0,0,,${tags}m 0 -22 l 7 -7 22 0 7 7 0 22 -7 7 -22 0 -7 -7`);
    }
  }
  return header + cues.join("\n") + "\n";
}

/** Keep narration dominant by ducking both camera sound and music during speech. */
export function campfireAudioFilter(duration: number, audio: CampfireAudio, narrationInput?: number, musicInput?: number): string {
  const filters = [`[0:a]aresample=48000,apad,atrim=duration=${duration},volume=${audio.sourceVolume ?? (narrationInput === undefined ? 1 : 0.12)}[camerabed]`];
  const inputs = [narrationInput === undefined ? "[camerabed]" : "[camera]"];
  if (narrationInput !== undefined) {
    const branches = musicInput === undefined ? "asplit=2[narration][camerasidechain]" : "asplit=3[narration][camerasidechain][musicsidechain]";
    filters.push(`[${narrationInput}:a]aresample=48000,apad,atrim=duration=${duration},loudnorm=I=-16:TP=-2:LRA=7,aresample=48000,${branches}`);
    filters.push("[camerabed][camerasidechain]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[camera]");
    inputs.push("[narration]");
  }
  if (musicInput !== undefined) {
    filters.push(`[${musicInput}:a]aresample=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${audio.musicVolume ?? 0.18},afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, duration - 0.8)}:d=0.8[musicbed]`);
    if (narrationInput !== undefined) filters.push("[musicbed][musicsidechain]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked]");
    inputs.push(narrationInput === undefined ? "[musicbed]" : "[ducked]");
  }
  filters.push(`${inputs.join("")}amix=inputs=${inputs.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000[audio]`);
  return filters.join(";");
}
