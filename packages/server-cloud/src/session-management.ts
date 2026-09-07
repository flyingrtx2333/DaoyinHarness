import { CloudError, SESSION_ACTIONS, type SessionAction } from "./repository.js";

export interface SessionState {
  pinnedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
}

export function sessionState(row: Record<string, unknown>): SessionState {
  return {
    pinnedAt: typeof row.pinned_at === "string" ? row.pinned_at : null,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    deletedAt: typeof row.deleted_at === "string" ? row.deleted_at : null,
  };
}

/** Set a desired state, never toggle: repeating an uncertain request is safe. */
export function applySessionAction(current: SessionState, action: SessionAction): SessionState {
  if (!SESSION_ACTIONS.includes(action)) throw new CloudError(400, "SESSION_ACTION_INVALID", "会话操作无效。");
  if (current.deletedAt) {
    if (action === "delete") return current;
    throw new CloudError(404, "RESOURCE_NOT_FOUND", "资源不存在或当前身份无权访问。");
  }
  const timestamp = new Date().toISOString();
  switch (action) {
    case "pin":
      if (current.archivedAt) throw new CloudError(409, "SESSION_ARCHIVED", "请先恢复已归档的会话。");
      return { ...current, pinnedAt: current.pinnedAt ?? timestamp };
    case "unpin": return { ...current, pinnedAt: null };
    case "archive": return { ...current, pinnedAt: null, archivedAt: current.archivedAt ?? timestamp };
    case "restore": return { ...current, archivedAt: null };
    case "delete": return { ...current, pinnedAt: null, deletedAt: timestamp };
  }
}
