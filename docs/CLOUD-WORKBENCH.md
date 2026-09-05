# 独立云端工作台

入口：<https://www.daoyintech.com/harness/>。此入口使用独立静态发布目录，通过同源 BFF 调用已上线的共享 AgentEngine。

当前应用是官网公开知识，支持会话列表、搜索、新建、多轮回答、检索状态、公开资料引用、刷新恢复与取消。访客授权有效期为 30 分钟；授权失效后需要明确重新进入，新访客空间不能读取旧空间。当前没有个人账户永久历史、企业空间、文件上传或本机文件/进程工具。

左侧“插件”展示业务能力与接入状态；输入框左下角“＋”选择可用插件。当前可选官网知识，短剧制作、网站与应用、文旅影像列为待接入。具体能力和授权边界见 [插件盘点](PLUGINS.md)。

## 代码与请求

- 云端页面：`packages/ui/src/cloud/`；本地页面仍为 `packages/ui/src/App.tsx`。
- BFF：`/api/company-assistant/agent`。浏览器只持有 HttpOnly 访客 Cookie 与内存 CSRF；不接触云服务 Bearer 或模型凭据。
- 每次任务提交前把 requestId、sessionId 和原问题写入 sessionStorage 回执。网络结果不确定时，先读取任务恢复；显式恢复沿用原 requestId 和正文，避免重复启动模型。
- 切换会话会取消旧视图读取，迟到响应不能覆盖当前会话。取消生成先等待正在提交的任务取得 Run，再请求服务端取消，保留已有事件。
- 模型 Markdown 禁止原始 HTML、危险链接与自动远程图片。资料展示只取公开字段。

## Windows 验证与构建

执行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。
客户端测试采用模拟 HTTP；投影测试采用事件回放夹具；这些不等同真实模型和浏览器验收。

提交相关源码及依赖锁后执行 `node scripts/build-workbench-release.mjs`。脚本从 Git HEAD 读取入口源码，校验实际使用的依赖版本与锁文件一致，输出 `.cache/workbench-release/<commit>/`、内容哈希资源和 release.json。`--preview` 仅用于未提交代码预览，不得发布。

## 部署与回滚

服务器目录：`/opt/daoyin-harness/workbench/releases/<commit>`；版本无覆盖上传，资源复制到共享 `assets/` 并长期保留。校验文件 SHA256 后原子切换 `current` 链接。Nginx 配置为 `deployment/harness-workbench.conf`，放入现有官网 server 的 extension include，检查通过后平滑重载。

该目录独立于官网 dist 和 Harness 服务端 releases。回滚只切换工作台 current 到上一版本；首次部署可移除单个工作台 include 后检查并重载 Nginx。保留访客数据库和历史资源，不重置云端会话。

验收需包含 HTTPS 页面/资源哈希、安全响应头、桌面与窄屏布局、真实问答、资料引用、刷新恢复和取消。具体已完成证据记录在 `deployment/RELEASE-20260905.md`。
