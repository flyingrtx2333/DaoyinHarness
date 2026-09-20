/**
 * 从工具名称与描述中提取精简的人类可读展示名称 (toolDisplayName)。
 *
 * @description
 * 若工具未显式提供 `displayName`，则从描述的第一句话（根据中英文标点逗号、句号、分号截断）中提取精简摘要；
 * 若提取出的摘要非空且长度不超过 24 个字符，则作为展示名称；否则回退为通用的 "执行操作"。
 * 常用于 UI 活动状态指示、事件流简报与 OpenTelemetry Span 属性标记。
 *
 * @param {string} _name 工具系统名称（如 "saishi_list_events"）
 * @param {string} description 工具系统描述说明
 * @returns {string} 提取出的人类友好中文展示名
 *
 * @example
 * ```json
 * // 示例 1: 从中文标点第一句提取
 * toolDisplayName("saishi_list_materials", "查询指定赛事的素材处理状态，按after_id继续读取。");
 * // 返回值: "查询指定赛事的素材处理状态"
 *
 * // 示例 2: 描述过长或无有效短句时回退
 * toolDisplayName("custom_tool", "这是一段非常冗长而且没有在24字之内停顿的工具描述说明，超过了字符上限限制");
 * // 返回值: "执行操作"
 * ```
 */
export function toolDisplayName(_name: string, description: string): string {
  const summary = description.trim().split(/[，。；;.!?！？]/u, 1)[0]?.trim() ?? "";
  return summary && summary.length <= 24 ? summary : "执行操作";
}
