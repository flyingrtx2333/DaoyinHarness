# 营火贴纸艺术字

## 实现

经用户明确要求，参考营火 `yinghuo-app/server/production-art-text.js` 的渲染方式，在 Harness 自有 ASS 时间轴上实现四层描边（底影、彩色厚边、白色外轮廓、文字）、轻微倾斜、弹入动画及两侧矢量星星。没有引入营火服务、字体文件或图片依赖；继续使用服务器已有 Noto Sans CJK SC。

保留 warm/fresh/gold 与 top/center 契约、正文字幕和真实音轨。字号按文字长度与画幅自适应，长标题换行；新计划 renderVersion=4，历史计划和成片不改写。

新制作默认编排少量艺术字；从已确认旁白连续摘录，保留否定和条件，不新增店铺事实。用户要求关闭时 artText=[]。当前时间粒度为已测量的逐句旁白时间轴，未引入营火逐字边界解析。

## 验证

部署 revision：`5c6baa898c5e8e5ed70c568c7069e329121a073c`，cloud runtime 与 resources 服务一致，健康检查通过。UI、营火服务和用户数据未修改。独立 Linux 服务器固定 Node 22 类型与构建检查通过；没有运行模拟模型或旧 Vitest，不等同于 Windows 检查。

真实账户（daoyintech）通过主平台共享模型路径执行 run `run_49a1920e-f5e5-41bd-b5c1-13f641c51a9a`，117975 ms，completed。输入为保留已有东北荟计划的镜头、字幕及音轨，另存新计划，添加三段 warm/fresh/gold 艺术字后直接渲染。实际执行 status、inspect 两次、plan、render；新计划 `res_e988f0462271444498ec83d1`，新成片 `res_5cd5bbca298f31811c4ad797`。未调用 narrate、music 或画面生成；旧成片保留。

成片 content digest `3fd51677b700b311745b411f099cdc30cd2130813a8fe65463d1b1c5dc133a34` 已核对，实际解码为 H.264/AAC、1080×1920、22.100秒。提取1、8、19秒真实帧并人工检查：橙黄、蓝白、金色艺术字、白色外边、底影、倾斜及两侧星星均可见，完整旁白字幕保留，无艺术字越界。

证据保存于 ignored `.cache/auto-campfire/harness-sticker-validation.json` 与 `campfire-sticker-{1,8,19}.png`。本轮未单独提取计费记录；按原平台统一计费链路调用，不宣称具体费用。样本验证了指定三段艺术字制作，默认自动摘录密度及横屏长标题尚未实测；没有逐字时钟对齐或全片主体遮挡自动质检。
