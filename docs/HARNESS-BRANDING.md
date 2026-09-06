# Harness 品牌资源

## 唯一标志

Harness 的唯一产品标志是 **Aurora Fold** 重绘资源：

```text
packages/ui/public/assets/harness-logo.png
```

该文件是当前发布与后续 Harness 页面使用的唯一来源。它的 SHA-256 为：

```text
9787c04c92cabad5f3e638744fe59e9c86b63041475f56c8e53222a6aed646ca
```

此规则适用于 Harness 所有自有界面与入口：云端工作台、后续本地工作台、空状态、助手标识、浏览器 favicon 和 apple-touch-icon。按比例显示，不拉伸、不重绘、不替换为文字或近似图形。

`packages/ui/public/assets/daoyin-logo.png` 是道引科技的既有品牌资源，不是 Harness 标志；Harness 页面不得把它作为产品 Logo 使用。

## 使用方式

云端工作台必须通过 `packages/ui/src/cloud/HarnessLogo.tsx` 使用该资源。它负责将同一文件用于侧栏、欢迎区和助手标识；云端发布脚本会把文件按内容哈希写入发布清单，并用于浏览器图标。

其他 Harness 页面直接引用 `/assets/harness-logo.png`，或复用等价的共享组件。不要使用概念图、页面截图或外部 URL 代替这个文件。

## 变更规则

只有明确的品牌决策才能更换该资源。更换时必须同时更新本文件的 SHA-256、共享组件、发布清单验证、favicon 验证和相应的浏览器验收证据；未经这些同步修改，不得在单个页面替换 Logo。
