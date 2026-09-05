import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginCatalog } from "./PluginBrowser.js";
import { filterPlugins, PLUGINS, selectablePlugin, sessionPlugin } from "./plugins.js";

describe("workbench plugin inventory and session binding", () => {
  it("only permits the deployed profile; business inventory cannot grant execution", () => {
    expect(selectablePlugin("company-knowledge")?.profileId).toBe("company-public");
    for (const id of ["story", "builder", "youji", "shell", "__proto__"]) expect(selectablePlugin(id)).toBeUndefined();
    expect(sessionPlugin("company-public")?.id).toBe("company-knowledge");
    expect(sessionPlugin("story")).toBeUndefined();
    expect(sessionPlugin("")).toBeUndefined();
  });
  it("searches actual capability descriptions and keeps unavailable integrations explicit", () => {
    expect(filterPlugins("字幕").map((plugin) => plugin.id)).toEqual(["story"]);
    expect(filterPlugins("  AI ").map((plugin) => plugin.id)).toContain("youji");
    expect(filterPlugins("不存在的插件")).toEqual([]);
    expect(new Set(PLUGINS.map((plugin) => plugin.id)).size).toBe(PLUGINS.length);
    const html = renderToStaticMarkup(createElement(PluginCatalog, { selectedId: "company-knowledge", onSelect: () => undefined, busy: false }));
    expect(html).toContain("已有短剧业务能力，尚未接入此工作台");
    expect(html.match(/暂不可选/gu)).toHaveLength(3);
    expect(html.match(/返回会话使用/gu)).toHaveLength(1);
    expect(html).not.toContain("安装插件");
  });
});
