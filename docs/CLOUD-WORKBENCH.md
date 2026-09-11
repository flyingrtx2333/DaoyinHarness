# 独立云端工作台

入口：<https://www.daoyintech.com/harness/>。此入口使用独立静态发布目录，通过同源 BFF 调用已上线的共享 AgentEngine。

唯一入口为 `/harness/`。登录后同一账号范围持久化会话列表、选择状态、多轮回答、工具状态、刷新恢复与取消；官网知识、赛事和 Story 工具共用同一个会话空间，由 Agent 按意图自动调用。支持 Story 图片和 MP4 参考素材上传；本机文件与进程工具尚未接入云端入口。

左侧“插件”只展示能力与接入状态。已经接入的插件显示“已启用”，无需选择、打开或逐插件授权；网站与应用、文旅影像仍按实际接入状态展示。具体权限规则见 [插件盘点](PLUGINS.md)。

## 会话管理

2026-09-07：Harness `8920d51`、主平台 `23439b75` 与 PostgreSQL 迁移已协调上线；真实访客小样本通过，赛事账号交互和浏览器视觉验收未完成。证据见 [会话列表管理](SESSION-MANAGEMENT.md)。

### 发布前记录（历史）

每行“⋯”菜单的置顶、归档、恢复和软删除已补充到 Harness 源码。主平台请求转发、新增数据库列及前后端发布需要协调接通；本轮未上线。交互、接口、数据保留与回滚限制见 [会话列表管理](SESSION-MANAGEMENT.md)。

## 代码与请求

- 云端页面：`packages/ui/src/cloud/`；本地页面仍为 `packages/ui/src/App.tsx`。
- BFF：官网 `/api/company-assistant/agent`，赛事 `/api/agent-apps/saishi/workbench`。浏览器使用 HttpOnly 访客/账号 Cookie 与内存 CSRF；赛事请求附带非秘密 `x-agent-account` 防止账号切换串用，不接触云服务 Bearer 或模型凭据。
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
