# Cloudflare Daily Report Sentinel

这个 Worker 是个人网站日报的外部云端兜底。它不生成日报，只检查 `beifen`
源仓库里当天两篇 ISO 日报是否存在；如果缺失，就触发现有 GitHub Actions
workflow `daily-report.yml`。

## Why Cloudflare

Cloudflare Workers Cron Triggers 独立于 GitHub Actions schedule，也不依赖本地电脑开机。
本项目每天只检查 6 次，适合 Workers Free plan 的轻量用法。

## Files

```text
workers/daily-report-sentinel/src/index.js
workers/daily-report-sentinel/wrangler.toml
```

Cron 使用 UTC 时间。当前配置：

```cron
0 1,3,5,7,9,11 * * *
```

对应北京时间 09:00、11:00、13:00、15:00、17:00、19:00。脚本是幂等的：
当天两篇日报已存在时会直接退出，所以多跑几次是安全的。

Worker URL:

```text
https://daily-report-sentinel.theman6660-daily-report.workers.dev
```

`workers_dev` 已开启用于健康检查和手动 dry-run，Preview URLs 已关闭。

## Deploy

先登录 Cloudflare：

```bash
npx wrangler login
```

设置 GitHub token secret：

```bash
npx wrangler secret put GITHUB_TOKEN --config workers/daily-report-sentinel/wrangler.toml
```

这个 token 需要能读取 `theman6660/beifen` 内容，并触发 Actions workflow。
经典 PAT 可用 `repo` 权限；细粒度 token 至少需要目标仓库的 contents read
和 actions write 权限。

部署 Worker：

```bash
npm run sentinel:cloudflare:deploy
```

## Local checks

语法检查：

```bash
npm run sentinel:cloudflare:check
```

本地 dry run 可用 Wrangler dev，然后请求 `/run?dryRun=1`：

```bash
npm run sentinel:cloudflare:dev
curl "http://localhost:8787/run?dryRun=1"
```

模拟缺失日但不触发：

```bash
curl "http://localhost:8787/run?dryRun=1&date=2099-01-01"
```

线上手动非 dry-run 触发需要额外设置 `MANUAL_TRIGGER_TOKEN`，并带上：

```bash
Authorization: Bearer <MANUAL_TRIGGER_TOKEN>
```
