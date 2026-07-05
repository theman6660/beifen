# Railway Daily Report Sentinel

这个服务是个人网站日报的外部云端兜底。它不生成日报，只检查 `beifen`
源仓库里当天两篇 ISO 日报是否存在；如果缺失，就触发现有 GitHub Actions
workflow `daily-report.yml`。

## Railway service

建议在 Railway 里新建一个独立服务，指向本仓库，使用：

```bash
npm run sentinel:daily-report
```

仓库根目录的 `railway.toml` 已经配置了这个 start command 和 cron。
Railway Cron 使用 UTC 时间。当前 cron schedule：

```cron
0 1,3,5,7,9,11 * * *
```

对应北京时间 09:00、11:00、13:00、15:00、17:00、19:00。脚本是幂等的：
当天两篇日报已存在时会直接退出，所以多跑几次是安全的。

## Environment variables

必需：

```bash
GITHUB_TOKEN=...
```

这个 token 需要能读取 `theman6660/beifen` 内容，并触发 Actions workflow。
经典 PAT 可用 `repo` 权限；细粒度 token 至少需要目标仓库的 contents read
和 actions write 权限。

可选：

```bash
DAILY_REPORT_REPO=theman6660/beifen
DAILY_REPORT_BRANCH=main
DAILY_REPORT_WORKFLOW=daily-report.yml
SENTINEL_DRY_RUN=false
```

本地 dry run：

```bash
npm run sentinel:daily-report -- --dry-run
```

测试缺失日但不触发：

```bash
$env:BJ_DATE="2099-01-01"; npm run sentinel:daily-report -- --dry-run
```
