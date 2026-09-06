# 赛事只读插件

## 同账号直接访问（2026-09-06 已部署）

2026-09-06 按用户要求取消第一方工作台的二次授权。登录道引账号后，平台自动派生当前账号及业务空间的执行身份，不需要签发凭证、选择 Agent 专用赛事清单或粘贴字符串；后台仍逐次验证有效成员身份、应用订阅与资源归属。只读是当前九项工具的交付范围；所有后续业务插件及赛事写入、生成、管理能力接入后都自动继承账号已有完整权限，无需补充授权，见 [ADR-0012](adr/0012-first-party-account-access.md)。

主平台密码/短信登录建立 HttpOnly 的第一方账号会话。已有登录可通过平台登录页用现有平台令牌升级会话，令牌不会传给 Harness。工作台 bootstrap 返回 `authentication: account` 与不含凭据的 `accountScope`，后续请求携带 `x-agent-account`，防止旧标签页在账号切换后提交旧问题。退出主平台或赛事后台会撤销账号会话，后台执行身份同时失效；切回工作台会重新核对账号并移除旧视图。

赛事读取跟随登录账号的当前租户，保留原有业务应用订阅检查。当前租户没有赛事业务访问权时明确拒绝，不借用其他用户或官网付款身份。内部执行凭据刷新不改变同账号/租户的会话空间；已有手动授权产生的历史不迁移。模型用量仍使用平台的赛事场景与次数限制。

配套修改位于 DaoyinTechnology 的 `first_party_accounts.py`、`agent_app_access.py`、账号/工作台路由与赛事只读能力层。账号表迁移、两个后端、两个前端和 Harness 工作台已发布，版本与验证见 [上线记录](../deployment/RELEASE-20260906-ACCOUNT-ACCESS.md)。`AGENT_ACCOUNT_ENABLED` 默认继承 `AGENT_SAISHI_ENABLED`；`FIRST_PARTY_ACCOUNT_ORIGINS` 默认仅允许官网与赛事官网，开发环境须显式指定来源。账号 Cookie 在正式道引子域之间共享，其他主机为 host-only。

供外部 MCP 客户端连接道引服务的手动凭据接口仍独立保留，不是 Harness 插件的授权流程。道引业务即使通过 MCP 接入 Harness，也必须自动继承当前账号权限。旧 `/workbench/connect` 返回 410，不能再用外部客户端凭据登录第一方工作台。

### 当前改造验证

Windows / Node 22.23.2：全仓 typecheck、lint、293 项测试、build 全部通过。原恢复测试的虚构范围与旧提示断言已修正，资源隔离未放宽，见 [验证记录](VALIDATION-20260906.md)。

本地 Edge 使用正式打包方式的预览与模拟平台接口，通过 9 组检查：1280/1920/390/320px 的会话、插件页和选择器，账号切换、退出状态、同账号草稿保留、官网访客入口，以及主平台已有登录直接跳回 Harness。截图与报告见 `output/playwright/account-access/`，可用 `node scripts/verify-account-access.mjs` 重跑；该脚本需要配套主平台官网先构建。没有真实模型或生产 Cookie 验收。

## 已部署版本的历史记录

2026-09-06：第一阶段已部署。运行时与工作台版本 `70061947e58ec61afda8a9a7203d797af56ee282`；主平台、赛事后端和赛事 Web 为 `8ab0b0aebfbf78b3226b7bd37bf87ce9e9e71a8b`。Windows CI 发布包构建成功，生产健康、资源哈希和未授权拒绝已检查；未运行测试套件或真实模型调用。入口为 `https://www.daoyintech.com/harness/?app=saishi`。

## 执行方式

云端新增 `saishi-readonly` Profile，与 `company-public` 并列，不混用身份、用量归属或会话数据。`platform-adapter.ts` 识别专用赛事授权后，走主平台 `/api/internal/agent-apps/v1/`；官网知识保留原有接口。

Profile 从主平台获取 Saishi 的受控能力定义，校验九个工具名称、权限、只读注解、输入 Schema 和结果字段。执行前通过主平台校验具体资源；工具执行也再次校验授权。`app.ts` 原有的只读限制没有移除。

`saishi_list_images` 直接返回赛事图片引用，默认 6 张、最多 12 张。工作台立即显示图片卡片，支持加载、重试和放大查看。优先读取原图、精彩照片，缺少照片时显示明确标注的视频预览图。图片复用当前账号权限，无需二次授权；聊天记录不保存存储地址或凭证。更多结果使用返回的 `source` 和 `next_after_id`，同轮不重复查询或无限翻页。详见 [ADR-0017](adr/0017-account-scoped-event-images.md)。

能力包括赛事列表/详情、设备快照、素材状态、图片展示、地图结构、已识别运动员、点位观察时间线、已有任务进度。不提供地图编辑、设备绑定、重跑分析、成绩发布或作品生成。

模型仍由 Harness 的通用循环驱动，主平台仅完成单轮工具调用模型请求，使用独立的 `saishi.agent_readonly` 场景。模型参数和工具定义不能由浏览器任意改写。次数上限和用量台账由主平台维护，不使用官网访客赞助或 Builder 钱包。

## 当前工作台入口

插件目录增加「赛事只读」，未登录时进入道引账号登录，已登录账号自动接入，不显示插件二次授权。选择后通过现有页面的 `?app=saishi` 切换到固定赛事 BFF，页面重载隔离上一插件的显示与客户端状态。

赛事后台「Agent 授权」仅供外部 MCP 客户端管理专用凭据。Harness 复用平台 HttpOnly 登录 Cookie，内部执行凭据由服务端管理，不进消息或浏览器本地存储。提交及会话创建仍会拦截凭证字符串。

成功 bootstrap、查询会话后才进入可用状态。失效或范围不足不会退回访客身份。模型调用配置缺失时也不能激活。可询问“列出我可查询的赛事”“查询某赛事素材处理状态”“查看该运动员的点位时间线”。准确对象仍需 Agent 查询确认，不能假设名称就是唯一编号。

当前地图数据以结构化工具结果参与回答，不提供对话内地图画布。交互地图/MCP Apps 属于后续阶段。

## 配置与配套发布

保留现有云端设置，增加 `DAOYIN_CLOUD_APP_SERVICE_TOKEN`，由部署环境注入独立随机密钥，与主平台 `AGENT_APP_SERVICE_TOKEN` 一致，不得复用已有公开业务服务密钥。不将它写入 UI 构建配置。

同步发布 sibling 仓库 DaoyinTechnology 中的主平台 `agent_apps` 桥接、`backend-saishi/agent/` 及授权管理页面；执行新增授权迁移，分配 `saishi.agent.read`，配置并启用 `saishi.agent_readonly` 模型。完整变量、数据库、Host/Origin 和网关要求见 `../DaoyinTechnology/backend-saishi/docs/agent-plugin.md`（相对于两个仓库的共同父目录定位）。

工作台的 `/api/agent-apps/saishi/workbench/` 同源路由必须指向主平台；内网 `/api/internal/agent-apps/v1/` 仅向可信服务开放。运行时仍保留当前监听/数据库/租约方式，不把宿主机回环地址当作其他容器可达地址。

## MCP 与本地模式

Saishi 同时提供无状态 Streamable HTTP `/mcp` 出口，复用同一能力层。支持手动配置专用 Bearer 的 MCP 客户端可接入，不需要使用云端模型场景；但主平台授权服务仍需可达。

本轮没有自动写入本地 MCP 配置或将密钥安装到客户端，也没有实现 OAuth 发现/动态注册、MCP Apps 或 A2A。原生云端适配与 MCP 是两种传输方式，不是两套业务实现。

## 第一阶段验收历史

最初发布仅检查生产健康、资源完整性和未授权拒绝，没有执行测试套件或类型检查。这是历史证据，不代表后续发布状态。账号改造验证见上文；图片展示及真实模型回归见[图片发布记录](../deployment/RELEASE-20260906-IMAGES.md)。未覆盖的其他业务查询仍不能据此称为全部真实验收通过。
