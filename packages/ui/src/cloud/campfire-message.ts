export interface CampfireMessageSelection { shopId: string; referenceId?: string; body: string }
const marker = /\[营火内置剪辑[；;]\s*店铺资料\s*id[：:]\s*(res_[a-f0-9]{24})([^\]\n]*)\]/iu;
export function parseCampfireMessage(message: string): CampfireMessageSelection | undefined {
  const match = marker.exec(message); if (!match || message.slice(0, match.index).trim()) return undefined;
  const reference = /[；;]\s*参考视频\s*id[：:]\s*(res_[a-f0-9]{24})/iu.exec(match[2] ?? "");
  return { shopId: match[1]!, ...(reference ? { referenceId: reference[1]! } : {}), body: message.slice(match.index + match[0].length).trim() };
}
export function readableCampfireText(text: string): string {
  return text.replace(new RegExp(marker.source, "giu"), "营火 · 实拍剪辑");
}
