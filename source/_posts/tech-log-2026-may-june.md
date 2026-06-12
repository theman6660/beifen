---
title: 技术日志：2026年5-6月
date: 2026-06-07 22:00:00
tags:
  - 技术日志
  - Agent
  - CSAPP
  - 微信Bot
  - 多Agent框架
  - 系统编程
categories:
  - 技术
---

# 技术日志：2026年5月 - 6月

## 5月29日

### Emergence World / Sonder 源码审计

看到一个叫 Sonder 的开源项目（GitHub: RedsonNgwira/sonder），被其 star 数迷惑。直接通过 gh api 拉取完整源码结构进行审计：

**技术栈拆解：**
- `simulation/loop.py` — 主循环逻辑，Agent 生成-交互-存档的核心调度
- `simulation/agent.py` — Agent 实体类，封装 LLM 调用和行为决策
- `simulation/world_builder.py` — 世界初始化，Agent 放置和环境参数
- `simulation/agent_loader.py` — Agent 从 Markdown 配置加载（性格、历史、目标）
- `db/models.py` — SQLAlchemy ORM，Agent、Message、Event 三张表
- `main.py` — FastAPI 入口，提供 REST API 和 WebSocket

**审计结论：** 架构本质是 LLM 循环 + 持久化 + Web 展示。Agent 之间的交互是串行轮询而非并行——world_builder 按顺序生成 Agent，loop 按顺序调用。多 Agent "社会" 的涌现性被串行架构限制。star 数高是因为概念吸引力而非技术深度。

**关键判断：** "感觉没有很大难度"——不是因为低估，是因为准确识别了串行架构的局限。真正的多 Agent 并行需要并发调度、竞态处理、共享状态一致性——这些在 Sonder 里不存在。

### Emergence World 实验分析

同时消化了一篇关于 Emergence AI 公司的长文——他们做了 Agent 社会实验，让 AI Agent 在虚拟世界中自组织、形成层级结构、产生意外行为。技术上关注的是：
- Agent 的性格注入机制（通过 system prompt 还是通过行为约束？）
- 交互协议设计（Agent 之间如何发现对方？消息格式是什么？）
- 工具使用权限的边界（哪些 API 可用，哪些被限制？）

---

## 5月30日

### 个人网站文章排序修复

hanxiaofan.site 的文章时间错乱。根因：Hexo 的 `date` frontmatter 字段格式不一致——有些用 ISO 8601，有些用简写格式。Hexo 的排序逻辑是按 date 字段的 `moment.js` 解析结果排列，不同的格式字符串导致解析偏移，新文章被排到旧文章后面。

另外怀疑 `updated` 字段覆盖了 `date`——`hexo-generator-index` 在某些配置下会将 `updated` 作为排序键。

### AI 日报首次排查

日报突然不生成。初步排查：
- GitHub Actions workflow 日志显示 `node ai-daily.js` 正常执行但没有产出 commit
- Gemini API 返回 200 但 content 为空——模型拒答但没报错
- 怀疑 prompt 触发了安全过滤但没被 catch 到

### 多Agent文章批判框架搭建

调试一个文章批判流程：一位"严苛的学术评审人"角色对文章做逻辑一致性、概念精确性、论证链条三方面的批判。技术实现：
- 通过 system prompt 注入评审标准（逻辑完备性权重 0.35、概念精确度 0.30、论证链条 0.35）
- 输出格式要求：逐段标注问题 + 严重度评级 + 改进建议
- 第一版问题：Agent 倾向于"找茬"而不是"判断"——对每个段落都给负面评价，缺乏区分度

---

## 5月31日 - 6月2日

### DeepSeek 多模态能力验证

DeepSeek 官方文档声称"支持图片输入"，但通过 Anthropic-compatible API 调用时：

```bash
curl -s "https://api.deepseek.com/anthropic/v1/messages" \
  -H "x-api-key: $DEEPSEEK_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{"role": "user", "content": [
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "'$(base64 test.png)'"}},
      {"type": "text", "text": "描述图片"}
    ]}]
  }'
```

返回：`"type": "image" → "Not Supported"`

**技术根因：** DeepSeek 的多模态能力部署在自有前端（web/app），走的是不同的推理管线。Anthropic-compatible API 端点只映射了文本接口，没有映射 vision 相关的路由。这不是 API key 权限问题，是基础设施层面的缺失。

### 微信 AI Bot 技术选型（多Agent辩论）

启动四Agent并行研究 + 辩论架构：

**Agent A（实用主义者）** 研究方案：
- iLink（微信 PC hook DLL 注入）— 最成熟，C++ 实现，WS 协议与外部通信
- ClawBot（基于 WeChatFerry）— Node.js 封装，社区活跃但维护不稳定

**Agent B（安全保守派）** 关注：
- 微信协议逆向的法律风险（违反 ToS 第 7.2 条）
- DLL 注入被安全软件标记为恶意行为的概率
- 账号封禁触发机制（频率限制、消息模式检测、设备指纹）

**Agent C（体验至上者）** 关注：
- iLink 的消息延迟（实测 200-500ms，取决于微信进程状态）
- 图片发送路径（iLink → WS → Node.js → image API → WeChat CDN → 消息构造）
- 主动消息 vs 被动回复的用户感知差异

**Agent D（前沿激进派）** 提出：
- 是否可以直接用微信 macOS 版的 Accessibility API 做 UI 自动化
- AppleScript/PyAutoGUI 方案的可行性
- 或者等 DeepSeek native multimodal API 后简化

**辩论收敛结论：** iLink + 抽象层兜底。抽象层设计：
```javascript
// 抽象层接口定义
interface WeChatAdapter {
  sendText(to: string, text: string): Promise<void>;
  sendImage(to: string, imageBase64: string): Promise<void>;
  onMessage(callback: (msg: Message) => void): void;
  getContacts(): Promise<Contact[]>;
}
// iLinkAdapter 和 ClawBotAdapter 分别实现
// 通过环境变量 WECHAT_DRIVER 切换
```

### API 密钥配置与微信接入

实际对接微信时使用的凭证：
- Chat API（DeepSeek Anthropic-compatible）：
- WeChat 接入（腾讯云/微信云开发）

接入流程：
1. 微信云开发平台创建环境
2. 配置消息推送 URL（需要 HTTPS + 备案域名）
3. Token 验证（微信服务器发 GET 请求，返回 echostr）
4. 消息加密/解密（

Token 验证是第一个坑——微信的验证请求格式和文档不一致，文档说 `signature/timestamp/nonce/echostr` 四个参数，实际返回顺序和大小写有差异。

### 多Agent辩论框架 v2 架构

v1 到 v2 的根本改进源于发现"假异构"：

**v1 架构（被淘汰）：**
```
主对话 → 同时启动4个Agent → 各Agent独立输出 → 在主对话中合并
```
问题：Agent 之间看不到对方的输出。分歧只是各自 prompt 的投影。

**v2 架构：**
```
主对话 → Agent A（搜索+论证）
       → Agent B（收到A全文+搜索+论证/反驳）
       → Agent C（收到A+B全文+搜索+论证/反驳）
       → Agent D（收到A+B+C全文+搜索+论证/反驳）
       → 批判Agent（三维评分：事实0.35+逻辑0.30+回应0.35，≥18通过）
       → 元批判Agent（审查批判Agent的公正性，≥20通过）
```

文件系统注入机制：
```python
# 每个Agent写盘，后续Agent从文件读取
output_path = f"debate-records/round_{n}/agent_{name}.md"
with open(output_path, 'w') as f:
    f.write(agent_output)
# 父对话只传路径，不传内容
next_agent_prompt = f"前置Agent输出见：{output_path}"
```

**关键设计决策：**
- 串行而非并行——因为需要后续Agent看到前置完整输出
- 文件而非上下文——绕过 LLM 上下文压缩导致的信息丢失
- 批判双层——单层审查容易漏掉自身盲区

### 搭建微信 Bot 的完整链路

最终实际运行时的技术栈：
```
微信APP → iLink(DLL注入) → WebSocket(ws://localhost:8555) 
→ Node.js bot.js → OpenAI SDK(DeepSeek compatible) 
→ DeepSeek V4 Pro → 响应 → 消息构造 → iLink → 微信
```

PM2 进程管理：
```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'wechat-bot',
    script: 'bot.js',
    watch: false,
    restart_delay: 3000,
    env: {
      NODE_ENV: 'production',
      DEEPSEEK_KEY: process.env.DEEPSEEK_KEY,
      WECHAT_DRIVER: 'ilink'
    }
  }]
};
```

### AI 日报继续恶化

同一天发现 AI 日报和社会日报双重异常：
- AI 日报产出内容约 200 字，之前是 800-1000 字——snippet 截断参数被改了
- 社会日报完全不产出——RSSHub 源需要 RSSHUB_URL 环境变量，但该 secret 只存在于 blog-source 仓库，日报实际运行在 beifen 仓库
- `daily-report.yml`（singular）名字本身就暗示之前可能改过名

根因逐渐清晰：**有两套脚本在并行运行**。根目录的 680 行版本（DeepSeek）和 hexo-scripts 的 280 行版本（Gemini）。CI/CD 用的是根目录版本，但排查时在 hexo-scripts 里看到的旧代码造成了误判。

---

## 6月3日

### 心理画像 Skill 搭建

用多Agent辩论框架的架构思想，搭建了一个 psych-profiler：

**多角度分析模型：**
```
输入文本 → Agent 1(精神分析视角: 童年/防御机制/潜意识冲突)
        → Agent 2(认知行为视角: 核心信念/自动化思维/行为模式)
        → Agent 3(人本主义视角: 自我实现倾向/价值条件/共情)
        → Agent 4(特质论视角: Big Five OCEAN 维度)
        → Agent 5(存在主义视角: 自由/责任/意义建构)
        → 综合Agent(整合+矛盾标注+置信度)
```

第一版被毙的原因：每个Agent各自输出一段然后拼在一起。"AI腔偏重"、"没有争辩的模型"——要的不是并行输出，是串行对抗。和辩论框架 v2 的问题完全一样。

第二版改为串行热注入 + 迭代收敛：
```
Agent 1 输出 → Agent 2 读取、反驳、补充 → Agent 3 读取前两者、深化
→ ... → 综合Agent 标注"所有Agent一致"vs"存在分歧"vs"证据不足"
→ 如果有未解决分歧，回到分歧点再做一轮
```

**心理学理论参考文件：** 整理了 `psychological-theories-reference.md`（40KB），覆盖：
- 弗洛伊德：防御机制分类、心理性发展阶段
- 荣格：集体无意识、原型、人格类型
- 阿德勒：自卑与补偿、出生顺序
- 罗杰斯：自我实现、无条件积极关注
- 贝克：认知三角、自动化思维
- 埃利斯：REBT、ABC模型
- Costa & McCrae：Big Five OCEAN
- Frankl：意义疗法、存在真空

### Codex 代理配置冲突

Codex 和 Claude Code 的代理配置冲突：

```toml
# .codex/config.toml 出现 invalid utf-8 sequence at byte 269
# 根因：配置文件在多次写入后被截断/覆盖，字节边界不完整
```

更根本的问题。Codex 的代理检测逻辑和 Claude Code 不同——Claude Code 从 settings.json 的环境变量读取，Codex 从 config.toml 读取。两个配置不同步。

修复：
1. 清理 `.codex/config.toml` 中的无效字节
2. 统一代理端口：codex 配置 
3. 为什么之前工作？——因为之前用的是 Clash 的系统代理（自动检测），不是手动配置

### ccswitch 工具审计

`ccswitch` 是一个 AI API 代理切换工具。排查流程：
- 检查 GitHub 项目源码（确认是否还在维护）
- 发现 ccswitch 使用的 OpenAI 官方端点，但当前环境用的是 DeepSeek Anthropic-compatible 端点
- ccswitch 的模型路由配置中有硬编码的 OpenAI 模型列表，不包含 DeepSeek
- Codex 通过 ccswitch 路由时，路由到了不存在的 `api.deepseek.com/responses`（OpenAI responses API 格式，但 DeepSeek 用的是 `/v1/chat/completions` 或 Anthropic `/v1/messages` 格式）
- 错误：`404 Not Found: url: https://api.deepseek.com/responses`

### 深度阅读 Skill 创建

基于多Agent辩论框架，创建了一个 reading-companion skill。用途：读完文章后，多个视角的 Agent 分别发问、批判、补充，产生比单一解读更丰富的理解。

触发机制：用户可以自己提供文章，也可以让 Agent 去搜索文章。

---

## 6月4日

### 金融市场认知建模

学习目标不是炒股，是建立对金融市场运作的认知模型。

**AVGO（Broadcom）分析：**
- 关注其 AI 芯片（定制 ASIC）业务 vs NVIDIA GPU 的竞争格局
- AVGO 的 VMware 收购整合进展
- 拆股（stock split）的机制和市场影响——拆股本身不改变公司价值，但影响流动性和散户可及性

**TradingView 技术指标认知：**
- MA/MACD/RSI/Bollinger Bands 的数学定义和使用场景
- 指标不是预测工具——是"市场状态的另一种表示"。MACD 金叉不代表要涨，代表"短期动量超过长期动量"
- 过度依赖指标 = 过拟合噪声

**大语言模型与金融：**
- DeepSeek 融资和估值讨论
- ChatGPT 发布时间线（2022年11月）
- 用 AI 做市场情绪分析的可行性——NLP 情感分析 + 社交媒体数据 + 新闻标题

---

## 6月5日 - 6日

### AI 日报完整诊断与修复

**问题全貌：**
1. 日报内容从 800-1000 字骤降到 200 字 → `max_tokens` 参数被修改
2. 社会日报完全停更 → RSSHUB_URL 环境变量缺失
3. 两个脚本版本并存（680行 DeepSeek vs 280行 Gemini）
4. workflow 文件名 `daily-report.yml`(singular) 暗示之前被重命名过

**Codex 修复审计：**
让 Codex 先进去修了一遍，然后审计其修改：
- Codex 改了 `max_tokens` 但没检查 RSSHub 源是否可用
- Codex 在 workflow 中添加了 `timeout-minutes: 30`——合理但没有解决根因
- Codex 没有发现两个脚本版本并存的问题

**Superpower 模式审计：**
1. 检查 workflow 的每一次 commit diff
2. 对比根目录和 hexo-scripts 的代码差异
3. 验证 GitHub Secrets 在两个仓库中的设置
4. 确认 CI/CD 实际运行的是哪个脚本

**修复措施（10项改进计划）：**
1. 统一脚本版本，删除 hexo-scripts 旧版
2. 修复 max_tokens 到合理值（1200+）
3. 在 beifen 仓库配置 RSSHUB_URL
4. 添加 RSSHub 源可用性检查（源不可用时用备用源）
5. AI 日报内容质量检查：生成长度 < 400 字时触发重试
6. 社会日报添加 fallback 源列表
7. workflow 添加清晰注释说明每个 step
8. 在 workflow 末尾验证 commit 是否成功
9. 统一两个日报的 prompt 模板风格
10. 添加每月生成的汇总统计



---

## 6月7日

### 编程指南16Agent并行架构

启动16个Agent并行产出，但 Agent 工具因 git worktree 限制被拒。

**技术障碍：**
Agent 工具内部调用 `git worktree add` 创建隔离工作区。Session 主目录 `C:\Users\Administrator` 虽然 `git init` 了，但 `.gitignore` 中有 `*` 规则导致几乎全部被忽略。`git worktree add` 克隆出的新 worktree 没有文件，被判定为"无效 git 仓库"。

**WorktreeCreate Hook 方案：**

Hook 接收 stdin JSON：
```json
{
  "session_id": "bbcfdc74-...",
  "transcript_path": "C:\\Users\\Administrator\\.claude\\projects\\...",
  "cwd": "C:\\Users\\Administrator",
  "hook_event_name": "WorktreeCreate",
  "name": "agent-a8f96bd3faf37bb58"
}
```

Hook 实现（settings.json）：
```python
import sys, json, os
d = json.load(sys.stdin)
p = os.path.join(d['cwd'], '.claude', 'worktrees', d['name'])
os.makedirs(p, exist_ok=True)
print(p)  # 必须作为最后一行输出——工具通过 stdout 获取 worktree 路径
```

**最终成果：** 6个Agent并行，全部成功。12篇月文章（合计约780KB）+ 1份完整合订本（92KB）。



