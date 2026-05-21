# Timer for Browser — Firefox 扩展

统计每天在**指定网站**上的前台停留时间。数据写入 `browser.storage.local`，**重启浏览器不会丢失**；**每日 0:00（本地时区）** 自动换日清零。

## 功能要点

| 能力 | 说明 |
|------|------|
| 多站点分项 | Gemini、知乎、小红书、抖音、B站（见 `sites.js`） |
| 持久化 | `storage.local` + 固定扩展 ID，关闭/重启 Firefox 后今日累计仍保留 |
| 定时落盘 | 每 1 分钟将进行中时长写入 storage |
| 关闭落盘 | 浏览器退出时尽量 flush 当前计时段 |
| 0:00 刷新 | `alarms` 预约下次本地午夜，到点归档昨日并清零今日 |
| 跨午夜 | 23:59–00:01 连续浏览会按自然日切分计入对应日期 |

## 项目结构

```
T4B/
├── manifest.json
├── sites.js           # 待统计站点
├── storage.js         # 持久化、换日、按日切分
├── background.js      # 计时逻辑
├── popup.html / popup.js
├── icons/timer.svg
└── README.md
```

## 安装方式

### 长期使用（推荐，重启不丢扩展）

1. 打包为 `.xpi` 或使用 [Firefox 开发者版](https://www.mozilla.org/firefox/developer/) / `xpinstall.signatures.required = false` 等方式安装未签名扩展。
2. manifest 中已配置固定 ID：`timer-for-browser@nowadays.local`，保证 storage 与扩展绑定稳定。

### 临时调试

`about:debugging` → 临时载入 `manifest.json`。  
**注意**：关闭 Firefox 后临时扩展会被移除，需重新载入；但同一 ID 下 **storage 数据通常仍会保留**。

## 测试清单

1. 在某配置站点前台停留 2 分钟 → 弹窗有数据  
2. 完全退出并重启 Firefox → 再次打开弹窗，今日时长仍在  
3. 将系统时间调到次日 0:01（或等到午夜）→ 弹窗显示 0，统计日变为新日期  
4. 23:58 起持续浏览某站至 00:02 → 昨日归档到 `usageHistory`，今日从 0 重新累计跨日部分  

## 存储格式

**今日（弹窗展示）**

```json
{
  "dailyUsage": {
    "date": "2026-05-21",
    "sites": { "bilibili": 600, "zhihu": 120 },
    "updatedAt": 1716300000000
  }
}
```

**历史（换日时归档，供后续功能扩展）**

```json
{
  "usageHistory": {
    "2026-05-20": { "bilibili": 3600 }
  }
}
```

## 新增统计站点

1. 编辑 `sites.js` 的 `TRACKED_SITES`  
2. 在 `manifest.json` 的 `permissions` 增加对应 `https://` 主机  
3. 重新载入扩展  
