# 成片字幕放大与上移

用户要求旁白字幕上移、增大。在既有 ASS 默认字幕样式中修改：竖屏字号58→72，距底部160→240；横屏/方形字号48→60，距底部80→110。行宽同步调整16→14、28→24个字符，保留按词换行与标点处理，避免增大后超出画面。艺术字大小与位置不变；新计划 renderVersion=5，历史成片不改写。

实现 revision `d202b13f1adb52481a5ea37c200506af0f7d232b`。resources 服务已部署该精确提交，健康检查通过；cloud runtime 与 UI 未重启。独立 Linux Node 22 类型与构建检查通过，不等同于 Windows 检查。

真实账户营火入口验证 run `run_097594c3-4187-4649-9fd5-dc30202ba682`，118113 ms，completed。通过平台共享模型路径执行 status、inspect（三次）、plan、render；新计划 `res_7f93e03c9584041ed264f747`，新成片 `res_4c1d6762a8bee24fc6885371`。沿用9个镜头、原旁白及配乐、三段艺术字，未调用新音轨或画面生成，旧成片保留。

真实文件SHA256 `46dd169920f524d327ce246cddbc5138684daa6972cbb5e0d76d69401cbfde6b`，H.264/AAC、1080×1920、22.100秒；解码1、8、19秒。人工对照1、8秒与之前成片：底部字幕已放大、上移，完整可读，无越界，艺术字未变。横屏/方形未实测。本轮未单独提取usage/cost，不宣称具体费用。ignored证据 `.cache/auto-campfire/harness-caption-validation.json`、`campfire-caption-{1,8}.png`。

首次未带能力标记的文字验证 run `run_3ecebc32-4545-4f2b-aede-77c382caa5c4` 误路由其他业务工具并失败，没有执行营火渲染；不计为通过。该普通文字路由问题是既知独立缺陷，本次未扩大范围修复。未运行模拟或旧Vitest测试。
