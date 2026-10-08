# 主平台登录会话限额：时区修复与发布记录

状态：用户已于 2026-10-08 明确授权；单行修正已提交、推送并发布，普通账号登录成功。
日期：2026-10-08。

## 已确认的原因

`/api/auth/login` 已完成用户名密码校验，随后创建第一方账号 Cookie 时
触发 `ACCOUNT_SESSION_LIMIT`（HTTP 429）。登录配额是同一账号每滚动小时
最多新建 20 个会话，不是当前连接数；注销或关闭终端不会释放创建配额。
测试驱动反复独立启动并丢弃各自 Cookie，增加了新建会话次数。

主平台数据库使用 SYSTEM/CST。`created_at` 为
`DATETIME DEFAULT CURRENT_TIMESTAMP(6)`，但限额查询用
`UTC_TIMESTAMP(6)-INTERVAL 1 HOUR`。两者差八小时，实际查询约九小时
创建记录。无须更改账号密码、权限或模型配置。

2026-10-08T14:11:36.850882Z，在同一数据库连接上对已授权测试账号
执行只读聚合：现有 UTC 条件计数 20，使用数据库当前时间的条件计数 4。
未读取或输出 Cookie、JWT、密码、账号标识、数据库凭据或其他用户记录。
按错误规则、且没有新成功创建或规则变动时，最早可新建会话是
2026-10-08T21:00:55.319175Z（北京时间 10 月 9 日 05:00:55.319175）。

## 可审阅的一处修改

目标为主平台 `services/first_party_accounts.py:122`，只更改该限额查询：

```diff
- cur.execute("SELECT COUNT(*) AS n FROM first_party_account_sessions WHERE actor_user_id=%s AND created_at>UTC_TIMESTAMP(6)-INTERVAL 1 HOUR", (uid,))
+ cur.execute("SELECT COUNT(*) AS n FROM first_party_account_sessions WHERE actor_user_id=%s AND created_at>CURRENT_TIMESTAMP(6)-INTERVAL 1 HOUR", (uid,))
```

创建和统计使用同一数据库时钟，继续保持 20 次/小时和参数化账号筛选。
不修改全局数据库时区，不迁移日期、不删除会话、不放宽身份或资源授权。
真实账号登录后，整轮三个 SWE 实例复用同一个内存 Cookie jar。

## 发布范围及影响

实际 API 运行在单个 `daoyintech-backend` 容器，固定监听
`127.0.0.1:6087`，Nginx 直接转发。当前 Compose/workflow 没有滚动或
蓝绿发布路径。更新该容器会短暂影响这个单体的 API 和共享登录，
不能承诺零中断。独立业务后端不需要切换。

授权后的实施须定位并保持现有主平台源码版本、模板 overlay 和部署配置，
从精确提交构建候选镜像；保留旧镜像及发布配置以便立即回滚。只更新
`backend`（避免整套 Compose 更新录制 worker）。Harness runtime、
Docker daemon、BuildKit、Nginx 和独立业务后端均不需要重启。
不以容器内临时修改代替可审阅、可回滚的源码提交。

发布前准备回滚和健康验证；发布后验证实际普通账号登录、原业务健康、
配额查询与时间基准。随后从本机准备的精确基线归档经正常账号能力
导入工作区，再执行三个小样本真实模型任务及独立官方评分。
没有推理预测时不得生成或宣称 SWE 分数。

## 授权边界

本仓库 [AGENTS.md](../../AGENTS.md) 第 5 行要求：
“Work only inside this repository unless the user explicitly authorizes a
coordinated change to the Daoyin main platform.”
第 34 行亦禁止未经明确授权修改 Daoyin 平台服务。
已有 Harness 修复与上传授权不等于发布这个共享主平台组件。
这份具体提案已由用户回复“ok”授权，包括单个共享 API 容器切换可能造成的
短暂中断。授权仅覆盖上述限额查询修正和相应 API 组件发布；不覆盖数据迁移、
全局时区修改或其他服务变更。实际实现提交、发布镜像和验证结果如下。

## 已执行的修复和发布

主平台提交 `682ef46dc1118460e6095c93c5d8e968a4e61680` 已推送 `main`，
父提交为 `05e5bc8da9e3e8b0337eec283c17fafc267effa5`。只有上述一行修改。
修改前文件与运行容器逐字节一致；修改后文件 SHA256 为
`c18569267205b06630a2562d32e8b70192b4acdb03db8269ead9b868c9b1a96a`。

发布保留实际线上模板镜像作为不可变基础，只复制这份修正文件：

- 基础：`sha256:aa9f4505197241e66b67108d6c7ad196ad71a17584e5e4a67412830bc2d87318`，
  原标签 `yinghuo-templates-05e5bc8`、原 OCI revision `ab079825`。
- 已运行候选：`sha256:507a122578376e4a8c2650804cf93d5c010e092f3b2eec15dbd03d5e494fcf2e`，
  标签 `login-quota-682ef46dc111`。新增标签记录完整修正提交、基础镜像和文件 hash；
  沿用基础 OCI revision，不能据此宣称整份最新主平台源码已部署。

2026-10-08T14:30:00.084Z 开始发布，14:30:23.777Z 验证 READY。
Compose 有效配置只变化 `backend.image`；使用 `--no-deps --no-build --pull never`
仅切换 backend。49 个其他运行容器的 ID/image/StartedAt、9 个保护服务的
PID/状态/启动时间均前后一致。基础和模板 Compose 文件未改，旧镜像及配置
保留可回滚；服务器原主平台 checkout 的未提交工作未被修改。

实际运行文件与提交文件一致；6087 健康接口、公共 API 健康接口、Builder 6101
健康接口和 Builder 容器到 backend 的健康接口均为 HTTP 200。
14:31:43.874Z 的同账号只读聚合：旧 UTC 条件计数 21，已部署的数据库当前时间
条件计数 3，阈值仍为 20，数据库时区未改。

随后实际 SWE 驱动单次普通账号登录和工作台 bootstrap 成功，取得已部署 Harness
revision `0a18ac4b2072272b6b265a51900c2122f391fc12`，整轮复用同一 Cookie jar。
该轮停在首块二进制源码上传、尚未调用模型，不能称为 SWE 通过。
登录证据在 `.cache/swebench-cloud-live/2026-10-08T14-30-36.624Z_25f087cb/report.json`；
发布/来源/部署脚本/发布后检查在 `.cache/login-quota-release-682ef46/`，
服务器对应目录为 `/root/login-quota-release-682ef46dc111/`。
