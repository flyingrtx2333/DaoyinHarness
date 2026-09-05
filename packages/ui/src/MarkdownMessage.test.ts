import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "./MarkdownMessage.js";

const render = (text: string): string => renderToStaticMarkup(createElement(MarkdownMessage, { text }));

describe("untrusted assistant Markdown", () => {
  it("renders structured answers, fenced code and GFM tables as semantic elements", () => {
    const html = render("## 项目概览\n\n- **目标**：整理资料\n- `README.md`\n\n```ts\nconst value = 1;\n```\n\n| 文件 | 状态 |\n| --- | --- |\n| 文档 | 已读取 |");
    expect(html).toContain("<h2>项目概览</h2>");
    expect(html).toContain("<strong>目标</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<div class="markdown-table"');
    expect(html).toContain("<table>");
  });

  it("does not execute HTML, unsafe URLs or auto-load remote images", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://tracker.invalid/pixel" onerror="alert(1)">\n\n[恶意](javascript:alert%281%29) [数据](data:text/html,test) [文件](file:///C:/secret) ![参考图](https://tracker.invalid/image.png)');
    expect(html).not.toMatch(/<script|<img|javascript:|data:text|file:\/\/\/|tracker\.invalid|onerror=/i);
    expect(html).toContain("[图片：参考图]");
  });

  it("keeps external citations usable with isolated tabs", () => {
    expect(render("[说明](https://example.com/docs)")).toContain('href="https://example.com/docs" target="_blank" rel="noopener noreferrer"');
  });

  it("accepts incomplete streamed markup and preserves literal code", () => {
    expect(render("正在读取 **未完成")).toContain("正在读取 **未完成");
    expect(render("```html\n<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });
});
