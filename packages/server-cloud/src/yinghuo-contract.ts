/** Independently specified bindings for Yinghuo's existing video-production MCP. */
export const YINGHUO_SCOPES: Readonly<Record<string, string>> = Object.freeze({
  yinghuo_list_shops: "yinghuo.read", yinghuo_get_profile: "yinghuo.read", yinghuo_list_assets: "yinghuo.read",
  yinghuo_list_references: "yinghuo.read", yinghuo_list_templates: "yinghuo.read", yinghuo_list_tasks: "yinghuo.read",
  yinghuo_get_task: "yinghuo.read", yinghuo_get_production: "yinghuo.read", yinghuo_get_queue: "yinghuo.read",
  yinghuo_create_video: "yinghuo.generate", yinghuo_modify_video: "yinghuo.write", yinghuo_resume_video: "yinghuo.generate",
  yinghuo_cancel_queue: "yinghuo.write", yinghuo_export_package: "yinghuo.export",
});

export const YINGHUO_MUTATIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(YINGHUO_SCOPES).filter(([, permission]) => permission !== "yinghuo.read")),
);
