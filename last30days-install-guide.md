# last30days-skill 使用指南

**安装时间**: 2026-03-04  
**安装路径**: `~/.claude/skills/last30days`  
**状态**: ✅ 已安装，需要配置 API keys

---

## 📋 安装完成

### 目录结构
```
~/.claude/skills/last30days/
├── SKILL.md              # Skill 定义和使用说明
├── scripts/
│   ├── last30days.py     # 主脚本入口
│   ├── lib/              # Python 库
│   └── ...
└── ...
```

---

## 🔧 配置步骤

### 1. 配置 API Keys

创建配置文件：

```bash
# 复制示例配置
cp ~/.config/last30days/.env.example ~/.config/last30days/.env

# 编辑配置
nano ~/.config/last30days/.env
```

### 2. 获取 API Keys

#### 必需（至少选一个）:

**选项 A: OpenAI API Key**（推荐）
- 访问: https://platform.openai.com/api-keys
- 创建 API key
- 费用: 按使用量计费

**选项 B: XAI API Key**（用于 X 搜索）
- 访问: https://x.ai/api
- 或直接使用浏览器 Cookie（见下文）

#### 可选（增强功能）:

**Apify API Token**（用于 TikTok）
- 访问: https://apify.com
- 免费额度: $5/月，无需信用卡

**Brave Search API Key**（用于网页搜索）
- 访问: https://brave.com/search/api/
- 免费额度: 2000 次/月

### 3. X 搜索认证（如不用 XAI API）

skill 支持从浏览器自动读取 X 的 Cookie：

```bash
# 确保已登录 x.com
# 首次运行时会提示允许 Keychain 访问
# 或手动设置环境变量:
export AUTH_TOKEN=your_auth_token
export CT0=your_ct0_token
```

---

## 🚀 使用方法

### 命令行直接运行

```bash
cd ~/.claude/skills/last30days/scripts

# 基础用法
python3 last30days.py "AI video tools"

# 快速模式（90秒）
python3 last30days.py "AI video tools" --quick

# 深度模式（5分钟）
python3 last30days.py "AI video tools" --deep

# 指定输出格式
python3 last30days.py "AI video tools" --emit md  # Markdown 格式

# 查看帮助
python3 last30days.py --help
```

### 在 OpenClaw 中使用

由于 OpenClaw 不直接支持 Claude Code 的 skill 格式，你可以：

**方式 1: 使用 exec 工具调用**
```
帮我运行 last30days 研究 "Claude Code skills"
```

**方式 2: 创建快捷命令**
在 `~/.zshrc` 或 `~/.bashrc` 中添加：
```bash
alias last30="python3 ~/.claude/skills/last30days/scripts/last30days.py"
```

然后直接使用：
```bash
last30 "AI video tools"
```

---

## ⚠️ 已知限制

### 在 OpenClaw 中的适配

1. **WebSearch 工具**: 
   - 原 skill 设计使用 Claude Code 的 WebSearch 工具
   - OpenClaw 有自己的 web_search 工具
   - 可能需要修改脚本适配

2. **Bash 工具**:
   - 部分功能依赖 Bash 工具执行命令
   - OpenClaw 支持 exec 工具，功能类似

3. **建议**:
   - 先在命令行测试确保功能正常
   - 在 OpenClaw 中通过 exec 调用
   - 或等待 OpenClaw 官方支持 skills

---

## ✅ 测试运行

### 步骤 1: 诊断检查

```bash
cd ~/.claude/skills/last30days/scripts
python3 last30days.py --diagnose
```

预期输出:
```json
{
  "openai": true,        // 需要配置 OPENAI_API_KEY
  "xai": false,          // 可选
  "bird_installed": true,
  "bird_authenticated": true,  // X 搜索需要
  "youtube": false,      // 可选
  "tiktok": false,       // 可选
  "hackernews": true,    // 免费，应该可用
  "polymarket": true     // 免费，应该可用
}
```

### 步骤 2: 测试运行

```bash
# 使用 mock 数据测试（不调用真实 API）
python3 last30days.py "test topic" --mock

# 真实运行（需要配置 API key）
python3 last30days.py "Claude Code skills" --quick
```

---

## 📝 使用示例

### 示例 1: Prompt 研究
```bash
python3 last30days.py "prompting techniques for ChatGPT legal questions"
```

### 示例 2: 工具学习
```bash
python3 last30days.py "Nano Banana Pro prompting"
```

### 示例 3: 趋势发现
```bash
python3 last30days.py "best AI video tools" --deep
```

---

## 🔗 参考链接

- **GitHub**: https://github.com/mvanhorn/last30days-skill
- **官方文档**: `~/.claude/skills/last30days/README.md`
- **Skill 定义**: `~/.claude/skills/last30days/SKILL.md`

---

## ❓ 常见问题

**Q: 运行时报错 "No module named 'xxx'"?**
A: 检查 Python 版本（需要 3.10+），确保 scripts/lib 目录在 Python path 中

**Q: X 搜索无法认证?**
A: 确保浏览器已登录 x.com，或手动设置 AUTH_TOKEN 和 CT0 环境变量

**Q: 运行时间太长?**
A: 使用 `--quick` 模式（90秒），或减少搜索范围 `--days 7`

**Q: 如何查看完整日志?**
A: 添加 `--debug` 参数

---

**配置完成后，告诉我，我帮你测试运行！** 🚀
