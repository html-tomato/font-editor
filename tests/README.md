# 回归验证

字体样本由脚本生成，不随仓库提交。生产页面不需要安装这些测试依赖。

需要 Node.js、Python 与 FontTools；DOM 集成检查另需 jsdom。

```sh
python -m pip install fonttools
npm install --no-save jsdom
python tests/make-fixtures.py
node tests/regression.cjs
node tests/dom-smoke.cjs
python tests/validate-fonts.py
```

可选：指定真实 TTF，验证数千字形字体的全局缩放与排版表保留。

```sh
FONT_TEST_SAMPLE=/path/to/font.ttf node tests/regression.cjs
```

本次验证：19 个基础回归场景、6253 字形真实字体、DOM 初始化/导入/导出/完整 HTML 再打开，以及 12 个导出结果的 FontTools 独立解析和校验和检查通过。

Canvas 在测试中使用模拟上下文，DOM 测试不代表浏览器像素、手机滚动或触控验证。VF 固化执行了页面里的 Python 实例化任务，但没有在浏览器内实测 Pyodide/WASM 启动。完整 HTML 打包测试使用真实脚本和样式，WASM 载荷使用测试替身。

当前边界：

- 带排版表的多个字符若共用一个字形，暂不支持为它们设置不同调整；会提示原因并停止导出。
- 位图/SVG 与 COLR v1 字体的部分修改暂不支持，会明确阻止不安全的写回。
- 预览会换行并限制画布容量，只显示开头；不会缩减导出的字体字库。
- Canvas 按字符绘制并计算字偶距，复杂文字塑形、连字的实际效果仍以安装后的字体为准。
- 在线页面没有启用 Service Worker 缓存；“保存到 HTML”会打包本地脚本、样式和 VF 引擎，供单文件离线使用。
