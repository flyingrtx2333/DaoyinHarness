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
export interface CampfireCaption { startSeconds: number; durationSeconds: number; text: string }
export function campfireDimensions(aspectRatio: string): [number, number] {
  return aspectRatio === "16:9" ? [1920, 1080] : aspectRatio === "1:1" ? [1080, 1080] : [1080, 1920];
}
export function campfireVideoFilter(segment: CampfireSegment, width: number, height: number, image: boolean): string {
  const size = `${width}:${height}`;
  let filter: string;
  if (segment.framing === "crop") {
    filter = `[0:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size}:(iw-ow)*${segment.cropX ?? 0.5}:(ih-oh)*${segment.cropY ?? 0.5}`;
  } else if (segment.framing === "contain") {
    filter = `[0:v]scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black`;
  } else {
    filter = `[0:v]split=2[background][foreground];[background]scale=${size}:force_original_aspect_ratio=increase,crop=${size},gblur=sigma=24[blurred];[foreground]scale=${size}:force_original_aspect_ratio=decrease[sharp];[blurred][sharp]overlay=(W-w)/2:(H-h)/2`;
  }
  if (image && segment.motion === "push-in") filter += `,zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`;
  return `${filter},setsar=1,fps=30,format=yuv420p[video]`;
}
function timestamp(seconds: number): string {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
export function campfireCaptions(segments: CampfireSegment[], width: number, height: number, narrationCaptions?: CampfireCaption[], generatedIndices: readonly number[] = []): string {
  const portrait = height > width;
  const fontSize = portrait ? 58 : 48;
  const lineLength = portrait ? 16 : 28;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,70,70,${portrait ? 160 : 80},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const cues: string[] = [];
  const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  let elapsed = 0;
  const timeline = narrationCaptions ?? segments.map(segment => { const cue = { startSeconds: elapsed, durationSeconds: segment.durationSeconds, text: segment.caption ?? "" }; elapsed += segment.durationSeconds; return cue; });
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
  return header + cues.join("\n") + "\n";
}

/** Keep narration dominant, duck music, retain only the requested amount of camera sound. */
export function campfireAudioFilter(duration: number, audio: CampfireAudio, narrationInput?: number, musicInput?: number): string {
  const filters = [`[0:a]aresample=48000,apad,atrim=duration=${duration},volume=${audio.sourceVolume ?? (narrationInput === undefined ? 1 : 0.12)}[camera]`];
  const inputs = ["[camera]"];
  if (narrationInput !== undefined) {
    filters.push(`[${narrationInput}:a]aresample=48000,apad,atrim=duration=${duration},loudnorm=I=-16:TP=-2:LRA=7,asplit=2[narration][sidechain]`);
    inputs.push("[narration]");
  }
  if (musicInput !== undefined) {
    filters.push(`[${musicInput}:a]aresample=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${audio.musicVolume ?? 0.18},afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, duration - 0.8)}:d=0.8[musicbed]`);
    if (narrationInput !== undefined) filters.push("[musicbed][sidechain]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked]");
    inputs.push(narrationInput === undefined ? "[musicbed]" : "[ducked]");
  } else if (narrationInput !== undefined) filters.push("[sidechain]anullsink");
  filters.push(`${inputs.join("")}amix=inputs=${inputs.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000[audio]`);
  return filters.join(";");
}
