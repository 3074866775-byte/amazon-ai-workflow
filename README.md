# 🦞 Amazon AI Workflow — DeepSeek v4 Pro

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-headless%20Chrome-orange.svg)](https://pptr.dev)
[![DeepSeek](https://img.shields.io/badge/AI-DeepSeek%20v4%20Pro-purple.svg)](https://platform.deepseek.com)

> Amazon跨境电商全流程AI工作流 — 竞品分析 → AI内容优化 → 多语言本地化 → 评论情感分析 → A+ Content生成

## ✨ 功能模块

| 模块 | 说明 | 技术 |
|------|------|------|
| 📋 **Listing 生成** | 爬取竞品标题/五点/描述 → AI重写优化 → 12语种本地化翻译 | Cheerio + DeepSeek |
| 🖼️ **A+ Content** | 生成品牌故事、产品对比表、场景化图文模块、技术规格 | DeepSeek + 图片支持 |
| 📊 **评论分析** | 竞品评论情感分析：痛点/赞美/未满足需求/使用场景/改进建议 | Puppeteer + Cookie登录 |
| 🌍 **多语言翻译** | EN/FR/DE/ES/IT/JP/PT/NL/PL/SV/AR/TR 12种语言 | DeepSeek API |
| 🔄 **版本切换** | Tab一键切换不同语言版本，独立复制 | 原生 SPA |

## 🚀 快速启动

```bash
git clone https://github.com/YOUR_USERNAME/amazon-ai-workflow.git
cd amazon-ai-workflow
npm install
npm start
```

打开 **http://localhost:3456**

## 🎯 使用流程

### Listing 生成 & A+ Content
1. 输入产品名称、卖点、备注
2. 粘贴竞品 Amazon 链接（最多5个）→ 自动爬取
3. 填入 DeepSeek API Key
4. 勾选目标语言版本
5. 点击生成 → AI优化输出

### 评论情感分析
1. 在Chrome登录 amazon.com
2. F12 → Application → Cookies → 复制 cookie 到输入框
3. 填入竞品链接 → 自动爬取评论 → AI深度分析
4. 也可直接粘贴评论内容，无需 cookie

## 📊 AI分析报告包含

- 🔥 **高频痛点** — 材质/尺寸/功能/包装/异味 分类
- ⭐ **高频赞美** — 卖点灵感来源
- 💡 **未满足需求** — "希望...就好了"
- 🎯 **使用场景洞察** — 买家真实用法
- 📊 **卖点建议** + ⚠️ **避坑指南**
- 🔧 **产品改进建议**（按优先级）
- 📈 **综合评分卡**（5维度评分）

## 🛠️ 技术架构

```
├── server.js                    # Express后端 (6个API路由)
│   ├── /api/scrape              # 单页爬取
│   ├── /api/scrape-all          # 批量爬取 (含状态透明化)
│   ├── /api/scrape-reviews      # 评论爬取 (Puppeteer + Cookie)
│   ├── /api/analyze-reviews     # 评论AI分析
│   ├── /api/generate            # Listing生成 + 翻译
│   ├── /api/generate-aplus      # A+ Content生成
│   └── /api/sync-translations   # 翻译同步
├── public/
│   └── index.html               # SPA前端 (3个模式切换)
├── 素材/                         # 图标 & 资源
└── package.json
```

## 📦 技术栈

- **后端**: Node.js + Express
- **前端**: 原生 HTML/CSS/JS (SPA, 零框架依赖)
- **爬虫引擎**: Cheerio (静态页) + Puppeteer (动态页/登录态)
- **AI模型**: DeepSeek v4 Pro (`deepseek-chat`)
- **代码量**: ~1000行 server.js + ~2500行 index.html

## ⚠️ 注意事项

- Amazon评论爬取需要登录 Cookie（Puppeteer 无头浏览器方案）
- 产品页(Listing/A+)爬取无需登录，直接可用
- DeepSeek API 调用消耗额度
- 生成内容建议人工审核后使用

## 📄 License

MIT
