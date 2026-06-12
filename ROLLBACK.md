# 个人网站回退与恢复手册

这份手册用于 `hanxiaofan.site` 意外出问题时快速恢复。核心原则只有一句：

**`theman6660/beifen` 是源码真相，`theman6660/theman6660.github.io` 是 Hexo 生成出来的成品。回退优先回退源码，再重新部署成品。**

## 1. 先判断坏在哪一层

| 现象 | 优先检查 | 推荐处理 |
| --- | --- | --- |
| 某篇文章内容错、日报错 | `source/_posts/*.md` | revert 那次文章提交，或改文章后重新提交 |
| 主题、导航、样式错 | `_config.yml`、`_config.redefine.yml`、`themes/` | revert 配置或主题相关提交 |
| GitHub Actions 绿了但页面没更新 | workflow 日志、Pages 仓库 | 用手动重部署 workflow 重新部署 |
| 页面 404 或空白 | `public/index.html` 构建结果 | 先本地/Actions 构建验证，再部署 |
| 自动日报持续失败 | `.github/workflows/daily-report.yml`、`ai-daily.js`、`society-daily.js` | 停止盲目部署，先修生成链路 |

不要直接在 `theman6660.github.io` 里手改页面。那里下一次部署会被覆盖。

## 2. 最安全的本地回退：revert 坏提交

适合：知道是哪一次提交弄坏了网站。

```powershell
cd D:\code\personal-website
git fetch --tags origin
git log --oneline --decorate -20
git revert <坏提交ID>
git push origin main
npm run clean
npm run build
npm run deploy
```

`git revert` 会新增一个“撤销提交”，不改写历史，适合和自动 workflow 共存。

## 3. 回到某个成功部署标签

适合：不知道哪里坏了，但知道某个 `deploy-*` 标签那天网站是好的。

先列出最近成功部署：

```powershell
cd D:\code\personal-website
git fetch --tags origin
git tag --list "deploy-*" --sort=-creatordate
```

安全回到某个标签，比如：

```powershell
git revert --no-commit deploy-2026-06-12-050556..HEAD
git commit -m "revert: rollback site to deploy-2026-06-12-050556"
git push origin main
npm run clean
npm run build
npm run deploy
```

注意：这个方法会撤销标签之后的源码变化。如果标签之后有你想保留的新文章，先把那些文章另存或单独挑回来。

## 4. 用 GitHub Actions 手动重部署

适合：源码没坏，只是 Pages 输出坏了，或你想把某个成功标签重新部署成线上页面。

操作路径：

1. 打开 GitHub 仓库 `theman6660/beifen`
2. 进入 `Actions`
3. 选择 `Manual Site Redeploy`
4. 点击 `Run workflow`
5. `ref` 填下面任意一种：
   - `main`
   - `deploy-2026-06-12-050556`
   - 某个 commit SHA
6. `reason` 写一句原因，例如 `rollback after broken style`

这个 workflow 只做三件事：

1. 检出指定源码版本
2. 运行 `npm ci`、`hexo clean`、`hexo generate`
3. 把 `public/` 强推到 `theman6660.github.io:main`

它不会生成日报，也不会改 `beifen` 源码。

## 5. 本地手动重新部署当前源码

适合：你在本机确认源码没问题，只想把当前版本重新发布。

```powershell
cd D:\code\personal-website
$env:HTTP_PROXY="http://127.0.0.1:7892"
$env:HTTPS_PROXY="http://127.0.0.1:7892"
npm run clean
npm run build
npm run deploy
```

部署前至少确认：

```powershell
Test-Path .\public\index.html
```

如果返回 `False`，不要部署。

## 6. 出事时不要做的事

- 不要上来就 `git reset --hard`，除非你明确知道会丢什么。
- 不要把 `theman6660.github.io` 当作源码备份。
- 不要在有未提交文章时随便切标签或回退。
- 不要在日报脚本还失败时反复部署 Pages，先修源码。

## 7. 日常预防习惯

每次手动改文章或配置后，先做：

```powershell
cd D:\code\personal-website
npm run build
git status --short
```

确认没问题再提交：

```powershell
git add <改动文件>
git commit -m "docs: ..."
git push origin main
```

只要重要内容进了 `beifen`，就有可靠回退点。
