# Harness 云端工作台 · A 雾白

用户在本分支对话选择 A；保持单一 A 方向。当前为本地源码实现，未 Git 提交、推送或部署。并未接入额外业务能力。

2026-09-06 Logo 修正：按用户澄清，使用此前选定的 Aurora Fold 重绘 PNG，替换近似的内联 SVG。原文件 selected-d-aurora-fold.png 原样复制到 packages/ui/public/assets/harness-logo.png，SHA256 为 9787c04c92cabad5f3e638744fe59e9c86b63041475f56c8e53222a6aed646ca。左上角、欢迎区、助手标识、favicon、apple-touch-icon 共用同一资源。没有使用道引科技旧 Logo；该旧文件保持原样。

构建脚本现在把 Logo 按内容哈希命名并加入发布清单；正式构建从提交读取二进制，preview 从当前工作区读取。浏览器验收使用实际发布脚本生成的本地预览，检查图片成功加载、原始字节相等、object-fit:contain 和图标URL。7组检查、14张截图、正常流程0控制台错误/0失败请求；过期401仍单独记录。下文迭代数值为 Logo 修正前的历史；logo-comparison.json 是修正后的对比，不把品牌变化当作布局错误。

## 布局与资产清单

生成参考原图实际为 1672×941，初始线上参考为 1280×720。保留原图，不拉伸或缩放来做指标对比；同尺寸浏览器截图与 selected-reference.png 对比。另外验收 1280×720、390×844、320×640。

| 层次 | 实现与约束 |
| --- | --- |
| 框架 | 1672px 宽时约 292px 侧栏；主画布 x≈292、y=21、右边距20、下边距21，圆角34 |
| 导航 | 会话、插件竖排；新会话蓝色主按钮；保留搜索、会话列表和真实访客授权时间 |
| 欢迎 | 居中 Logo、今天想完成什么、两项真实问题建议；不增加未授权功能 |
| 输入区 | 约1108×192；下方固定；左下角加号、已选插件和右侧发送/停止；弹层可用键盘关闭 |
| 插件 | 官网知识可用；短剧制作、网站与应用、文旅影像待接入；目录沿用相同视觉体系 |
| 字体 | 现有系统字体栈；正文与控制均为 DOM 文本，不使用远程字体 |
| Logo | HarnessLogo.tsx 引用选定的 harness-logo.png，消费于 .brand-mark、.empty-mark、.mini-mark；object-fit:contain 保持比例 |
| 图标 | 独立编写 WorkbenchIcon.tsx 的简单 SVG 路径；.workbench-icon、.plugin-mark |
| 背景 | .workbench、.main、.empty-state::before 使用原生 CSS 颜色、圆角与径向渐变 |
| 位图 | 仅重绘 Logo 是运行时位图；整页概念图仍只作为 evidence，不作为背景 |

本次源文件：packages/ui/src/cloud/App.tsx、PluginBrowser.tsx、main.tsx、新增 WorkbenchIcon.tsx、cloud-modern.css。原 cloud.css 和 HarnessLogo.tsx 的已有未提交修改保留。新样式单独导入，只作用于云端入口。会话客户端、投影、授权和后端没有改动。

## Windows 验证

- Node 22.23.2，Windows PowerShell。
- npm run typecheck：通过。
- npm run lint：通过。
- npm test：45 个文件、220 个测试通过。
- npm run build：通过。根构建包含本地 UI；云端 UI 另由浏览器验收脚本打包当前源码并验证。
- node scripts/verify-cloud-modern-ui.mjs：6 组交互检查、14 张截图，生产模式浏览器 bundle + 明确的业务接口替身，不调用线上模型。
- 覆盖：插件可用状态、Escape 焦点恢复、目录搜索、返回输入框、建议问题、提交、工具进度、取消、引用展开、重连/刷新回放、会话搜索、新会话、窄屏导航、授权过期。
- 正常流程 console errors = 0，failed requests = 0。过期用例故意返回401，其预期控制台记录单独列于 browser-report.json。
- 1672/1280/390/320 宽度均无页面水平溢出，主输入框在可视区；插件目录/长对话在各自内容区滚动。未模拟手机软键盘或真实手机设备。
- git diff --check 通过；新增图标/样式中没有参考图路径、data:image 或远程资产引用。
- 验收脚本关闭其创建的浏览器与独立随机端口本地服务。

## 对比与迭代

第1轮 desktop-picker-v1.png：MAE 0.01904，相似度0.98096，容差24内像素96.34%。五处主要差异：

1. geometry：侧栏 (20,112,252,650)，条目宽度多约9px，下部身份区偏下约20px。
2. geometry：输入区 (418,657,1108,192)，相比参考低约5px。
3. geometry：弹层 (381,461,254,302)，相比参考偏高约11px。
4. typography：弹层 (390,490,230,255)，名称与状态字号偏小。
5. asset：欢迎区 (920,230,95,95)，现有品牌 Logo 与生成图示意标识不同。

第2轮 desktop-picker-v2.png：MAE 0.01673，相似度0.98327，容差内96.86%。修正侧栏、输入区、弹层外框后，五处主要剩余差异：

1. typography：弹层 (390,490,230,255)，字号和内部行位置；下一轮加大名称/状态并调整行高。
2. asset：欢迎区 (920,230,95,95)，保留实际 Logo。
3. state：输入区 (416,650,1110,198)，空输入发送按钮保持禁用；可访问焦点边框与概念不同。
4. typography：欢迎区 (700,350,560,150)，系统字体字形和建议按钮宽度。
5. state：侧栏 (30,800,220,60)，展示真实到期时间，而不是静态“授权30分钟”。

第3轮最终 desktop-picker.png：MAE **0.01629**，像素相似度 **0.98371**，容差24内像素 **96.94%**。整体三项数值门槛通过；主画布、输入框和弹层主要边界约在参考3px内。五处剩余差异：

1. asset：(920,230,95,95) 使用真实品牌 SVG，形状不匹配生成示意。
2. typography：(700,350,560,150) 标题与建议按钮保留系统字体，文字渲染及局部位置未逐像素一致。
3. typography/state：(378,470,258,300) 弹层使用真实关闭按钮、键盘焦点、浏览全部插件文案；与概念仍有字体/布局差异。
4. state：(416,650,1110,198) 空输入禁用发送、焦点边框、左对齐真实占位符与参考的示意状态有差异。
5. state：(30,800,220,60) 实际授权时间随请求改变，不写死；截图仅冻结动画和光标。

comparison.json 的局部指标显示 welcome MAE≈0.05276、picker MAE≈0.04434（picker 容差内89.42%）。因此**不能声称全部关键区域逐像素门槛通过或100%复刻**。整体指标改善且布局/交互验收通过，剩余差异保留以匹配现有品牌与真实产品状态；没有降低原门槛。参考图、报告、diff、overlay、区域清单与原始截图均保留。

## 证据

- [最终桌面弹层](desktop-picker.png)
- [最终桌面空会话](desktop-empty.png)
- [插件目录](desktop-plugins.png)
- [手机](mobile.png)
- [320px 手机](mobile-small.png)
- [浏览器报告](browser-report.json)
- [最终对比报告](comparison.json)
- [对比叠图](overlay.png)
