# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概述

**LinuxDoHelper** — 基于 Chrome Extension Manifest V3 的浏览器插件，用于自动浏览和智能回复 [linux.do](https://linux.do) 论坛帖子。接入 DeepSeek V4 Flash 大模型进行内容评估和回复生成。

**开发语言**：纯 JavaScript（无构建工具、无 npm 依赖、无 package.json）

## 项目结构

```
linuxdo-helper/
├── manifest.json              # Chrome 扩展配置 (MV3)
├── background.js              # Service Worker — 主编排器
├── lib/
│   ├── storage.js             # chrome.storage.local 封装（持久化层）
│   ├── scheduler.js           # 时间调度 + 速率限制器
│   ├── deepseek-client.js     # DeepSeek API 客户端
│   └── topic-filter.js        # AI prompt 模板 + 评估/回复流水线
├── content/
│   └── content.js             # Content Script — DOM 提取与交互
├── popup/
│   ├── popup.html             # 弹出面板 UI
│   ├── popup.js               # 面板逻辑
│   └── popup.css              # 面板样式（深色主题）
└── icons/
    └── icon128.png
tests/
└── background-regressions.test.js  # Service Worker 回归测试（node:test）
```

## 架构架构

### 通信模式

```
Service Worker (background.js)
    ↕ chrome.runtime.sendMessage    ↕ chrome.tabs.sendMessage
Popup UI (popup.js)              Content Script (content.js)
                                  ↕ DOM 操作
                              linux.do 论坛页面
```

### 核心流程

1. **Service Worker** 通过 `chrome.alarms` 定时触发检查（5min 新帖/10min 通知/60min 清理）
2. **导航式 DOM 操作**：background 调用 `chrome.tabs.update()` 导航到目标 URL，等待页面加载完成，然后通过 `chrome.tabs.sendMessage()` 向 content script 发送指令
3. **Content Script** 执行 DOM 提取（帖子列表/详情/通知/版块）或 DOM 交互（填写编辑器/点击提交按钮），结果通过 `chrome.runtime.sendMessage()` 返回给 background
4. **AI 流水线**（`topic-filter.js`）：价值判断 → 生成回复 → 安全审核，全部通过 DeepSeek API 完成

### 关键设计决策

- **无 ESM 模块**：MV3 Service Worker 不支持 ES modules，使用 `importScripts()` 按序加载 lib 文件
- **所有状态持久化**：使用 `chrome.storage.local` 存储，支持 Service Worker 的唤醒/休眠生命周期
- **指数退避**：连续错误时暂停，`60s * 2^(errorCount-1)`，最大 15 分钟
- **双时段调度**：每天支持两个工作时段（如 09:00-12:00 和 14:00-18:00），跨时段自动休息
- **定时触发 vs 即时响应**：popup 通过 `chrome.runtime.sendMessage` 请求状态，background 实时响应（非 alarm 驱动的交互）

## 开发命令

由于项目无构建工具和依赖管理器，所有操作通过 Chrome Extension 的加载与重载完成：

```bash
# 加载插件到 Chrome
# 打开 chrome://extensions → 开启"开发者模式" → "加载已解压的扩展程序"
# 选择 linuxdo-helper/ 目录

# 修改代码后重新加载
# 在 chrome://extensions 页面点击扩展的刷新按钮
# 或右键扩展图标 → "重新加载"

# Service Worker 调试
# chrome://extensions → 点击 LinuxDoHelper 的 "service worker" 链接
# 打开 DevTools 控制台查看日志

# Content Script 调试
# 在 linux.do 页面打开 DevTools → Console
# 日志前缀 [LinuxDoHelper]

# Popup 调试
# 右键扩展图标 → "审查弹出内容"

# 回归测试
node --test tests/background-regressions.test.js
```

## 状态层（storage.js）

主要存储键，全部使用 `chrome.storage.local`：

- **settings**：API Key、时段配置、版块过滤、回复频率、回复语言
- **state**：暂停状态、已跟踪帖子/通知、回复历史、速率限制计数器
- **activityLog**：活动日志（最大 500 条）
- **persistedOp**：当前运行态快照，独立于 `state` 写入，避免覆盖业务状态

注意：`deepMerge()` 只做浅层合并，嵌套对象会整个替换而非递归合并。

## 调度与限频（scheduler.js）

- `isWithinWorkingHours()`：基于当天双时段配置检查当前时间是否在工作时段
- `canReplyNow()`：检查是否达到每小时上限和最小回复间隔
- 频率预设：conservative（3条/小时，间隔20min）、moderate（8条/小时，间隔5min）、aggressive（15条/小时，间隔2min）

## API 客户端（deepseek-client.js）

- 兼容 OpenAI API 格式，调用 `https://api.deepseek.com/chat/completions`
- 默认模型 `deepseek-v4-flash`，温度 0.7，最大 tokens 1024
- `chat()`：基础对话
- `chatJson()`：强制 JSON 输出模式（通过 `response_format: { type: 'json_object' }`）

## Content Script 注意事项

- **Discourse 兼容性**：所有 DOM 选择器基于 Discourse 论坛的 HTML 结构，包括 `[data-topic-id]`、`.topic-post[data-post-number]`、`.d-editor-input` 等
- **回复流程**：点击回复按钮 → 等编辑器出现 → fill textarea → dispatch `input`/`change` 事件 → 点提交 → 等编辑器关闭确认
- **MutationObserver**：用于等待元素出现/消失，实现"导航 + 等待 + 操作"模式

## 变更历史

[2026-06-26] background - 修复运行态持久化覆盖 state、手动运行早退卡住、提交失败仍等待间隔、限频队列状态未落盘的问题
[2026-06-26] tests - 新增 `tests/background-regressions.test.js`，覆盖 Service Worker 状态与队列回归行为
