# 主平台登录会话限额：时区修正提案

状态：只读诊断和修正提案；未修改或发布主平台。
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
这份文档是确认前的具体提案，实际主平台修改及发布尚未授权、未执行。
