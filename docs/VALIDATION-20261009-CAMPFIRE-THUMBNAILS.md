# 营火 WebP 缩略图实际验证

日期：2026-10-09；真实云端 `https://harness.daoyintech.com/`，既有 daoyintech 账号。

## 修订与发布

- Harness UI/资源服务：`0cbbde221586d2792a411b5cc517b3ca303fb464`。
- 主平台媒体 BFF：`745c03ce79316ee7f23aad63b850574be0b768d6`，只覆盖 `routes/agent_apps.py` 和新增 `services/harness_thumbnail.py`。
- 独立 Linux 服务器 Node 22.23.2 打包、资源 readiness、公开 UI 文件摘要通过；只切换资源服务和主平台媒体 BFF/UI。Agent、媒体执行器、原营火和其他受保护服务未重启；无数据迁移。
- macOS Node 22 定向 UI/server-cloud TypeScript 检查、Python 语法检查和差异空白检查通过。未执行 Windows 验收、模拟接口或旧测试套件。

## 实际素材与页面

通过当前浏览器账号请求实际资源路径，12 张既有参考视频、店铺照片和实拍视频封面加载成功，卡片只挂载 `<img>`，没有原 MP4 `<video>`。封面最长边480px、WebP质量35，实际2,104–18,054字节。横图480×270/360、竖视频270×480均保留比例。

| 真实资源 | 原文件字节 | WebP字节 |
| --- | ---: | ---: |
| 东北荟照片 `res_7cf8ee87060568dae3abce70` | 728257 | 15386 |
| 店铺视频 `res_1cab8ddf9b2ac712f56fcc2a` | 3555909 | 13164 |
| 参考视频 `res_4b08c01cb6cd5b0101324266` | 16065792 | 12092 |

实际刷新页面后，以上12个资源的 `campfire.thumbnail.ready` 持久化事件仍各1条，未重复生成。点击店铺视频封面后，预览使用无 `thumbnail` 参数的原文件路径，播放器实际 `readyState=4`、1280×720、时长14.433991秒，播放后 `paused=false`。320px viewport中页面 `scrollWidth=320`，无水平溢出。截图和有界只读核查位于忽略目录 `.cache/campfire-thumbnail-live/`。

## COS 阻塞

服务器既有 COS 连接已配置，实际 `PutObject` 成功。但同一服务凭据对私有对象的 `GetObject` 和 `GetObjectACL` 均返回 `AccessDenied`，读取私有 COS 的验收未通过。页面当前使用已核验源摘要的原生 WebP 备用路径；这不是 COS 命中证据。代码显式写入私有 ACL，不公开素材、不修改 CAM 或桶策略。需要为现有服务账号补充仅 `harness/thumbnails/v1/` 前缀的 `GetObject` 权限，或者提供既有可读私有 COS 连接，然后复验真实字节和摘要。

本次是实际资源、媒体和 UI 验证，没有模型调用、AI生成或成片重渲染；不作为新的 Agent 行为验证结果。
