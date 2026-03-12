# last30days-skill 免费使用指南（无 OpenAI API Key）

**适用场景**: 没有 OpenAI API Key，但仍想使用 last30days-skill

---

## 🆓 免费数据源（无需 API Key）

### 1. Hacker News - 完全免费 ✅

**可用性**: 始终可用，无需认证
**内容**: 技术讨论、创业、AI 相关话题
**适合**: 技术趋势、开发者工具、开源项目

**使用方式**:
```bash
python3 last30days.py "Fast-DDS" --search hackernews
```

---

### 2. Polymarket - 完全免费 ✅

**可用性**: 始终可用，无需认证
**内容**: 预测市场、实时赔率、事件概率
**适合**: 了解人们对未来事件的看法（选举、科技、体育）

**使用方式**:
```bash
python3 last30days.py "AI development" --search polymarket
```

---

### 3. X (Twitter) - 免费（浏览器 Cookie）✅

**可用性**: 需要已登录 x.com 的浏览器
**内容**: 实时讨论、 viral 内容、专家观点
**适合**: 流行趋势、社区讨论、实时新闻

**设置方式**:

#### 方法一：自动读取（推荐）
```bash
# 确保 Safari/Chrome/Firefox 已登录 x.com
# 首次运行时会提示允许 Keychain 访问，点击"允许"

# 测试 X 搜索是否可用
node ~/.claude/skills/last30days/scripts/lib/vendor/bird-search/bird-search.mjs --whoami
```

#### 方法二：手动设置 Cookie
```bash
# 从浏览器获取 Cookie（开发者工具 → Application → Cookies → x.com）
export AUTH_TOKEN=你的_auth_token
export CT0=你的_ct0_token

# 然后运行
python3 last30days.py "Claude Code" --search x
```

---

### 4. Brave Search API - 免费额度 ✅

**可用性**: 免费 2000 次/月，无需信用卡
**内容**: 网页搜索、新闻、博客
**适合**: 综合信息、新闻报道、博客文章

**申请步骤**:
1. 访问 https://brave.com/search/api/
2. 注册账号
3. 获取 API Key（免费 tier）
4. 配置到 `~/.config/last30days/.env`:
```bash
BRAVE_API_KEY=你的_brave_key
```

---

## 🔧 修改脚本以支持无 OpenAI 模式

由于原脚本依赖 OpenAI API 进行结果综合，我们需要修改脚本使用本地方式：

### 方案 A: 仅使用原始数据（无需 OpenAI）

创建简化版脚本：

```bash
cat > ~/.claude/skills/last30days/scripts/simple_last30.py << 'EOF'
#!/usr/bin/env python3
"""简化版 last30days - 无需 OpenAI API"""

import sys
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

from lib import hackernews, polymarket

def search_hackernews(topic, days=30):
    """搜索 Hacker News"""
    print(f"🔍 搜索 Hacker News: {topic}")
    # 调用 HN API
    results = hackernews.search(topic, days=days)
    return results

def search_polymarket(topic):
    """搜索 Polymarket"""
    print(f"🔍 搜索 Polymarket: {topic}")
    # 调用 Polymarket API
    results = polymarket.search(topic)
    return results

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 simple_last30.py <topic>")
        sys.exit(1)
    
    topic = sys.argv[1]
    
    print(f"📰 研究主题: {topic}")
    print("=" * 50)
    
    # 搜索多个免费源
    hn_results = search_hackernews(topic)
    pm_results = search_polymarket(topic)
    
    # 输出原始结果（不经过 OpenAI 综合）
    print("\n📊 Hacker News 结果:")
    for item in hn_results[:5]:
        print(f"  - {item.get('title', 'N/A')}")
        print(f"    {item.get('url', 'N/A')}")
    
    print("\n📊 Polymarket 结果:")
    for item in pm_results[:5]:
        print(f"  - {item.get('question', 'N/A')}")
        print(f"    概率: {item.get('probability', 'N/A')}")

if __name__ == "__main__":
    main()
EOF

chmod +x ~/.claude/skills/last30days/scripts/simple_last30.py
```

---

### 方案 B: 使用本地 LLM（如果你有）

如果你有本地运行的 LLM（如 Ollama）：

```bash
# 安装 Ollama（如果还没有）
# https://ollama.com

# 在 .env 中配置本地模型
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2
```

---

## 🚀 立即使用（推荐方案）

### 步骤 1: 测试免费数据源

```bash
cd ~/.claude/skills/last30days/scripts

# 测试 Hacker News
python3 -c "from lib import hackernews; print(hackernews.search('Fast-DDS', days=7))"

# 测试 Polymarket  
python3 -c "from lib import polymarket; print(polymarket.search('AI'))"
```

### 步骤 2: 配置 X 搜索（可选但推荐）

```bash
# 测试 X 认证
node lib/vendor/bird-search/bird-search.mjs --whoami

# 如果显示用户名，说明认证成功
```

### 步骤 3: 申请 Brave Search（推荐）

1. 访问 https://brave.com/search/api/
2. 注册免费账号
3. 复制 API key 到 `~/.config/last30days/.env`

---

## 📝 使用示例（免费模式）

### 示例 1: 仅使用 Hacker News + Polymarket

```bash
cd ~/.claude/skills/last30days/scripts

# 修改脚本跳过 OpenAI 调用
# 或者直接使用我创建的简化版
python3 simple_last30.py "DDS middleware"
```

### 示例 2: 使用 X + HN + Polymarket（无需 OpenAI）

```bash
# 设置 X Cookie（如果自动读取失败）
export AUTH_TOKEN=$(grep auth_token ~/Library/Application\ Support/Google/Chrome/Default/Cookies 2>/dev/null | head -1)

# 运行（修改后的脚本）
python3 last30days.py "Claude Code" --search x,hackernews,polymarket --no-native-web
```

---

## 💡 替代方案：使用其他工具

如果配置 last30days 太复杂，还有其他免费工具：

### 1. 直接使用我（旭旭助手）+ WebSearch

我可以直接帮你：
- 搜索 Reddit、X、HN 的讨论
- 综合多个来源的信息
- 生成报告

**示例**:
```
搜索过去30天关于 "Fast-DDS" 的讨论，包括 Reddit、Hacker News 和技术博客
```

### 2. NotebookLM + 你提供的链接

- 收集相关网页链接
- 上传到 NotebookLM
- 生成综合报告

### 3. Perplexity AI（免费版）

- 访问 https://perplexity.ai
- 使用免费版搜索实时信息
- 有引用来源

---

## ✅ 推荐方案总结

| 方案 | 成本 | 复杂度 | 效果 |
|------|------|--------|------|
| **配置 X + HN + Polymarket** | 免费 | 中 | ⭐⭐⭐⭐ |
| **申请 Brave Search** | 免费 | 低 | ⭐⭐⭐⭐ |
| **使用我 + WebSearch** | 免费 | 极低 | ⭐⭐⭐ |
| **修改脚本用本地 LLM** | 免费 | 高 | ⭐⭐⭐⭐ |

---

## 🎯 我的建议

**最简单方案**: 
1. 申请 Brave Search API（5分钟，免费 2000 次/月）
2. 配置 X Cookie（自动读取）
3. 使用 `hackernews` + `polymarket` + `x` + `brave` 组合

**或者**:
- 直接告诉我你想研究什么主题
- 我用 WebSearch 工具帮你搜索多个来源
- 生成类似 last30days 的综合报告

**你想怎么继续？** 🐾
