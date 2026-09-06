# 紧凑工作台界面发布

2026-09-06，云端 Harness 工作台发布侧边栏与插件目录的紧凑样式改版。

## 运行版本

- Git 提交：`12d96a7229ef905558927bd074f70cc934bcf0ba`。
- 原子切换前版本：`2193783fa55b23e94ae3ceca2ac1ab17718ea776`，保留在服务器 releases 目录，可直接回退。
- 发布清单共 4 个文件，服务器校验后才切换 `current`：
  - `index.html`：`6df1a9fcf30d99559a6f46756234bb153e985edc4c070fef6737fddb43cd4b67`
  - `workbench-AP6YAVIN.js`：`42c86bb7f125f456889663b273fe9dcb356741e63114e2b0ce7e359224b02e13`
  - `workbench-ETQTF3MM.css`：`5ecbf7b8935e0defa83431d6b2aeb978811bb1908593fbf9422a9dd8f1d8dcdb`
  - `harness-logo-2ETAMKXU.png`：`9787c04c92cabad5f3e638744fe59e9c86b63041475f56c8e53222a6aed646ca`

## 范围与验证

- 侧边栏采用固定页脚、独立滚动的会话列表、会话搜索空状态和紧凑导航；插件目录移除冗余说明与能力标签，仅保留名称、简要描述和可执行状态。
- 全站样式参数写入 `design-tokens.css`，并在 `AGENTS.md` 与 `UI-STYLE-RULES.md` 中规定后续页面改版复用字体、间距、控件尺寸和圆角规则。
- Windows 提交版浏览器验收通过：9 组交互检查、25 张截图，无控制台错误或失败请求。覆盖侧边栏长列表、键盘焦点、窄屏、插件筛选、200% 文本和卡片溢出。
- 公网 HTTPS 验收通过：发布清单的 4 个文件均逐项 SHA-256 一致；页面返回 `no-store`、CSP、`X-Frame-Options: DENY` 和 `nosniff`。真实浏览器页面加载后，插件目录显示 4 张卡片、1 个可用操作、3 个待接入状态；字号、侧栏和卡片间距分别为 14px、240px 和 16px。
- 本轮没有发送真实模型问题；上述浏览器验收只验证页面加载、会话授权初始化和插件目录交互。

共享工作区中另有未提交的服务端记忆与恢复相关改动。全仓 lint、test 和 build 的失败不属于该提交，发布产物由已提交 Git 对象单独构建，未包含这些修改。
