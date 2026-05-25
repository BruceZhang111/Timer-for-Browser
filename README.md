# Timer for Browser — Firefox 扩展

统计每天在**用户自行添加的网站**上的前台停留时间。数据写入 `browser.storage.local`，**重启浏览器不会丢失**；**每日 0:00（本地时区）** 自动换日清零。

## 功能要点

| 能力 | 说明 |
|------|------|
| 追踪列表 | 无内置站点，全部由用户在弹窗中添加 |
| URL 解析 | 完整链接自动归纳为 `https://域名/*` |
| 删除 | 主界面每行 **×** 可移除追踪项 |
| 持久化 | `customSites` 保存在本机，重启后列表仍在 |
| 0:00 刷新 | 每日本地午夜自动开始新一天统计 |

## 使用

1. 点击扩展图标 → 右上角 **+** 添加网址（需允许该域名权限）
2. 在对应网站前台浏览即可累计时长
3. 点击行末 **×** 删除不再追踪的站点

## 项目结构

```
T4B/
├── manifest.json
├── sites.js           # 解析、添加/删除追踪站点
├── storage.js         # 今日时长持久化
├── background.js
├── popup.html / popup.js
└── icons/timer.svg
```

## 存储格式

**追踪列表**（`customSites`，永久保留）

```json
[
  {
    "id": "site_zhihu_com",
    "name": "知乎",
    "hosts": ["zhihu.com"],
    "pattern": "https://zhihu.com/*",
    "origins": ["https://zhihu.com/*", "https://*.zhihu.com/*"]
  }
]
```

**今日统计**（`dailyUsage`，每日 0:00 清零）

```json
{
  "dailyUsage": {
    "date": "2026-05-21",
    "sites": { "site_zhihu_com": 600 }
  }
}
```
