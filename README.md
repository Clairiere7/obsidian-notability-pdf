# Notability PDF (Obsidian plugin)

Notability 风格的 PDF 手写批注插件。在 Obsidian 里打开库中的任意 PDF,用钢笔 ✏️、荧光笔 🖊️、文字高亮 🖍️、橡皮 🧹 做批注。

**关键:pdf.js 已本地打包、worker 内联为 blob URL,不依赖 CDN,所以能在 iPad / 移动端跑(绕过 Obsidian 移动端的 CSP)。**

## 为什么能在 iPad 上用

| 之前(CDN 版) | 现在(本地打包版) |
|---|---|
| 从 `cdnjs.cloudflare.com` 动态加载 pdf.js | pdf.js 打进 `main.js`,离线可用 |
| Obsidian 移动端 CSP 拦截外部脚本 → iPad 白屏 | 无外部请求,通过 CSP |
| 高分屏(iPad Retina)显示模糊 | canvas 按 `devicePixelRatio` 渲染,清晰 |

## 安装

**方式一(手动):**
1. 下载仓库里 `main.js`、`manifest.json`、`styles.css` 三个文件
2. 放进你的 vault 的 `.obsidian/plugins/notability-pdf/` 目录
3. Obsidian → 设置 → 第三方插件 → 关闭「安全模式」→ 启用 **Notability PDF**

**方式二(BRAT):** 用 BRAT 插件添加本仓库,自动安装更新。

## 使用

- 侧边栏 ✏️ 图标:打开库中第一个 PDF
- 命令面板:`Open PDF in Notability` / `Open any PDF in Notability`
- 右键任意 PDF → `Open in Notability`
- 工具栏切工具,`Ctrl+Z/Y` 撤销/重做,`Ctrl+S` 保存

## 批注存储说明(重要)

批注保存为 PDF 同名的 `.nota.json` 附属文件,**不写进 PDF 本身**。所以:

- ✅ 在插件里能正常显示、撤销、重做
- ❌ 换到 Obsidian 自带阅读器 / GoodNotes / Notability 里看不到这些批注
- ✅ 把 `.nota.json` 一起同步(iCloud/坚果云/Git),批注会跟着走

## 开发

```bash
npm install
npm run build   # 产出 main.js
```

`main.js` 由 esbuild 从 `src/main.ts` 打包,`obsidian` 保持 external(由宿主提供)。
