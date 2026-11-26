# 清溯 Zora

一个跑在本地的小型个人知识仓库，加一块数据看板。零依赖 Node，纯 Markdown 存盘。

## 里面有什么

- **编辑视图**（`/`）：左边目录树，可拖拽把文章挪到别的分区、或拖到底部的垃圾桶删除；右边 Markdown 编辑器，支持 `[[双链]]`、标签、面包屑。
- **数据看板**（`/dashboard.html`）：今天怎么样、待办与倒数日、今日评分、今天吃了什么、关于我。
- **关系图谱**（`/graph.html`）：双链构成的力导向图。

## 结构

```
server.js          零依赖 HTTP 服务（默认 8686）
lib/store.js       记录读写：一天一行
lib/indexer.js     全文索引、双链、标签
public/classic.html  编辑视图
public/dashboard.html  数据看板
public/graph.html  关系图谱
data/              文章与记录（仓库里只留空目录骨架）
```

## 跑起来

```bash
node server.js
```

然后打开 <http://localhost:8686>。想不开浏览器就 `KB_NO_OPEN=1 node server.js`。

## 数据格式

`data/records/YYYY-MM.md`，一天一行：

```
11.26 | sleep=85 | study=60 | meal=早餐:400:酸奶 + 燕麦:78
```

`data/todos.md` 记待办和倒数日，`data/metrics.json` 存指标，`data/prefs.json` 存偏好。

文章就是 `data/` 下的普通 `.md`，用 `[[标题]]` 互相链接。图片放在 `data/` 里，用 `/data/xxx.png` 引用。

## 说明

仓库里 `data/` 只保留空目录和 `.gitkeep`，正文内容不进版本库——你 clone 下来是一个能跑的空壳，把自己的 `.md` 扔进去就活了。
