# Timer for Browser — Firefox 扩展

统计每天在**指定网站**上的前台停留时间（开发初期站点列表见 `sites.js`）。

## 当前统计站点

| 显示名 | 域名 |
|--------|------|
| Gemini | gemini.google.com |
| 知乎 | zhihu.com |
| 小红书 | xiaohongshu.com |
| 抖音 | douyin.com |
| B站 | bilibili.com |

## 项目结构

```
T4B/
├── manifest.json
├── sites.js           # 站点列表（id、名称、匹配域名）
├── background.js      # 计时、按站点写入 storage
├── popup.html / popup.js
├── icons/timer.svg
└── README.md
```

## 本地加载（Firefox）

1. `about:debugging#/runtime/this-firefox` → **临时载入附加组件** → 选择 `manifest.json`
2. 打开上表任一站点并保持标签在前台、Firefox 有焦点
3. 点击扩展图标，弹窗应显示各站点分项时长与合计

## 新增或修改统计站点

1. 编辑 `sites.js` 的 `TRACKED_SITES`
2. 在 `manifest.json` 的 `permissions` 中增加对应 `https://` 主机权限
3. 重新临时载入扩展

## 存储格式

```json
{
  "dailyUsage": {
    "date": "2026-05-21",
    "sites": {
      "gemini": 120,
      "zhihu": 300,
      "bilibili": 600
    }
  }
}
```

跨自然日自动清零；旧版仅 B 站单字段数据会在读取时迁移到 `sites.bilibili`。
