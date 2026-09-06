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
    expect(html).toContain("检索道引产品与方案的公开资料");
    expect(html.match(/待接入/gu)).toHaveLength(3);
    expect(html.match(/aria-label="使用/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="打开赛事只读"');
    expect(html).not.toContain("连接授权");
    expect(html).toContain('aria-label="使用官网知识"');
    expect(html).not.toContain("尚未接入此工作台");
    expect(html).not.toContain("plugin-capabilities");
    expect(html).not.toContain("安装插件");
  });
  it("requires a verified account profile before enabling private model work", () => {
    expect(selectablePlugin("saishi")).toBeUndefined();
    expect(selectablePlugin("saishi", ["company-public"])).toBeUndefined();
    expect(selectablePlugin("saishi", ["saishi-readonly"])?.profileId).toBe("saishi-readonly");
    expect(filterPlugins("赛事", ["saishi-readonly"])[0]?.status).toBe("available");
  });
});
