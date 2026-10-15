# 存档格式

存档是普通文件夹，设计目标是：**二十年后不用松果也能打开**。

```
data/archive/<年>/<月>/<标题>-<url哈希前6位>/
  <YYYYMMDD-HHmmss>/        每次入藏一个快照（内容没变不会新建）
    article.html            自带样式的离线阅读页，图片和附件用相对路径
    article.md              Markdown 版本，开头有原文链接和存档时间
    content.html            净化后的正文片段
    source.html             抓到的原始网页
    page.mhtml              浏览器入藏时的整页快照（Chrome / Edge 可以直接打开）
    screenshot.png          浏览器入藏时的整页截图
    assets/<sha1>.<ext>     图片（按原地址哈希命名，自动去重）
    attachments/<文件名>     附件
    meta.json               原文地址、标题、作者、发布时间、存档方式、内容哈希、图片与附件清单、警告
```

数据库 `data/acorn.db`（SQLite）记录存档与快照的索引、全文检索、批注和标签。丢了数据库，文件夹依然完整可读；
`meta.json` 足以重建索引。

原文状态：

| 状态 | 含义 |
|---|---|
| alive | 最近一次检查时原文还在、内容没有明显变化 |
| changed | 原文内容变了，已经另存一个新版本 |
| gone | 原文 404 / 410，或页面显示「已删除」「违规无法查看」等 |
| unknown | 暂时无法确认（网络错误、被拦截） |
