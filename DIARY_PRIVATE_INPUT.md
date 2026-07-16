# 日记私有素材输入

原始 snippets 包含个人活动记录，不能提交到公开仓库。日记生成器只接受以下两种输入。

## GitHub Actions

在 `theman6660/beifen` 的 Actions secrets 中创建 `DIARY_SNIPPETS_JSON`，格式必须带日期：

```json
{
  "date": "2026-07-16",
  "snippets": [
    { "time": "09:20", "reply": "完成某项工作" }
  ]
}
```

payload 内的 `date` 是权威日期。即使 Actions 因排队跨过北京时间午夜，也会生成 payload 指定日期的日记，不会误写到第二天。workflow 只提交生成的 `source/_posts/diary-YYYY-MM-DD.md`，不会提交 payload。

未配置 Secret 时，定时任务会安全跳过并留下 notice，不会产生每日失败告警；手动触发仍会明确失败，提醒先提供私有输入。

## 本机

默认把私有 JSON 放在：

```text
.local-artifacts/private-snippets/YYYY-MM-DD.json
```

该目录已被 Git 忽略。文件可以使用上面的对象格式，也兼容旧数组格式；旧数组格式的日期来自文件名。也可通过 `DIARY_SNIPPETS_FILE` 指向其他本机文件：

```powershell
$env:DIARY_SNIPPETS_FILE = 'D:\private\diary-input.json'
node diary-generator.js --date 2026-07-16
```

不要把 JSON 直接写进 `.env`；多行内容应使用文件或 GitHub Secret。
