# Story 快速视频插件

本轮为源码接入，尚未部署或完成真实模型/视频验收。主平台与 Story 改动在 Windows 的 D:\AllProjects\DaoyinTechnology 主工作区；Harness 改动在此服务器主工作区，均保留其他进行中的工作。

## 能力

入口 /harness/?app=story。复用道引账号 Cookie 和 Story 创作空间，自动解析权限与费用归属，不要求粘贴令牌或逐插件授权。

五项工具：story_video_options、story_recent_videos、story_get_video、story_estimate_video、story_create_video。上传图片/MP4 后向对话附加素材 ID，视频任务由 Story 持久化，工作台从同账号接口定期刷新状态并播放完成视频。

目标不明确时澄清历史作品、上传视频或新生成；上下文已明确则沿用。完整历史视频作为视频参考，不把尾帧续写当作编辑。当前不提供保留原画面只替换音轨的配音能力；用户需要先接受参考生成新版本这一差异。

只对 story-quick 的 story_create_video 开放业务写入。所有工具仍需平台实时授权、参数校验和资源归属验证。子 Agent 仅能读取；生成由主对话执行。Story 使用独立的严格幂等审计，失败或未知结果不自动重新准入。

## 部署条件

先发布主平台与 Story 接口，再发布 Harness 运行时和工作台。主平台配置 AGENT_STORY_ENABLED=1 和 STORY_AGENT_URL，复用既有私有桥接密钥和账号会话。Story 必须能访问主平台 /api/internal/agent-story/v1/actor。

应用主平台 backend/db/migrations/20260911_story_harness.sql，再为 story-lab.agent_quick 配置并启用支持工具调用的模型。迁移默认禁用，不复制密钥或改变用户余额。视频上传代理需支持 250MB 加 multipart 开销。

当前线上只读检查：不存在 agent_quick 绑定，Story 执行连接为 0。未作生产配置变更、数据库迁移、提交或发布。

## 验证记录

2026-09-11：独立 Linux 服务器云端/UI TypeScript 检查通过；工作台 --server-linux --preview 打包通过。Windows Story 开发 Docker 镜像构建和新路由加载通过，主平台既有开发镜像中新路由加载通过；主平台全新镜像遇到依赖下载超时。

尚未验证真实模型澄清、真实视频生成/声音、浏览器上传与播放、账号隔离及重试计费。使用真实账号和 3–5 项小样本完成这些验收，不执行模拟套件。主平台完整接入说明在 backend-story/docs/harness-quick.md。
