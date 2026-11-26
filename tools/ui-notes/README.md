# 界面标注（开发用）

对着运行中的松果页面提修改意见：点一个元素、或拖出一块区域，写下要怎么改。每条标注记下页面、元素的选择器和文字、
当时的样式、窗口宽度和主题，存进 `tools/ui-notes/notes.json`（不进 git），Agent 读它逐条修改，改完把 `status` 设成
`done`、在 `reply` 里写改了什么，页面上的图钉就变成绿色。

## 启动

用一份演示数据跑后端（别用自己的 `data/`），再用这份 Vite 配置起前端：

```bash
env ACORN_PORT=7716 ACORN_HOST=127.0.0.1 ACORN_DATA_DIR=tmp/demo-data ACORN_PASSWORD=acorn-demo node --disable-warning=ExperimentalWarning --watch-path=src src/server/main.ts
```

```bash
env ACORN_DEV_BACKEND=http://127.0.0.1:7716 npx vite --config tools/ui-notes/vite.notes.config.ts --port 5174 --host 127.0.0.1
```

打开 http://127.0.0.1:5174 ，右下角是工具栏：

- **✎ 标注**：点选元素（标注时点链接、按钮不会触发）或按住拖出区域；⌘↵ 保存，Esc 退出
- **整页**：对整个页面写一条
- **☰**：所有标注，点一条跳过去
- **◉**：显示 / 隐藏图钉

工具在 shadow DOM 里，不受松果的样式和快捷键影响，也不影响它们；前端改动照常热更新。
