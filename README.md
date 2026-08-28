# 🦴 前臂与手部 AR 解剖教学工具

> AR Forearm & Hand Anatomy — 基于 WebAR 的前臂与手部肌肉骨骼互动教学工具

通过手机摄像头识别手部姿态，实时叠加 3D 前臂与手部骨骼、肌肉模型。核心教学功能：**手势动作识别 + 肌肉联动高亮** —— 学生做屈腕、握拳、伸指等动作时，参与运动的肌肉自动高亮，直观理解"这个动作由哪些肌肉完成"。

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🎥 AR 识别 | MediaPipe Hands 追踪手部 21 关键点，模型实时跟随手的位置/大小/朝向 |
| 🦴 骨骼模型 | 28 块真实解剖骨骼：桡骨、尺骨、8 块腕骨、5 块掌骨、14 节指骨 |
| 💪 肌肉模型 | 32 块真实解剖肌肉：前臂屈肌群、伸肌群、鱼际肌、小鱼际肌、骨间肌、蚓状肌 |
| ✨ 联动高亮 | 识别 8 种手势动作（握拳/伸指/屈腕/伸腕/拇指屈/拇指伸/对掌/旋前/旋后），高亮参与肌肉 |
| 🖐 手动模式 | 无需摄像头，拖拽旋转、滚轮缩放，适合课堂大屏演示 |
| 🔧 调试面板 | 实时显示手部置信度、手指弯曲角、腕部角度、识别动作、高亮肌肉数 |
| 🧩 图层开关 | 骨骼 / 肌肉 / 联动高亮可独立开关 |

## 🚀 快速开始

### 方式一：本地运行

```bash
cd ar_forearm
python -m http.server 8765
```

浏览器打开 `http://localhost:8765`（电脑直接可用，含摄像头）。

### 方式二：手机访问（AR 模式）

摄像头需要 **HTTPS 安全上下文**，局域网 HTTP 地址在部分浏览器会被拒绝授权摄像头。推荐：

- 部署到 GitHub Pages / Gitee Pages（HTTPS，学生可直接访问）
- 或使用内网穿透（如 ngrok）生成临时 HTTPS 链接

### 使用说明

1. 打开页面 → 点 **▶ 开始**（AR 模式）或 **✋ 手动查看**（演示模式）
2. AR 模式：将手伸到摄像头前 30–50 cm，做动作观察肌肉高亮
3. 底部按钮可切换骨骼/肌肉显示、开关联动高亮、切换前后摄像头

## 🧠 技术栈

- [Three.js](https://threejs.org/) (r170) — 3D 渲染
- [MediaPipe Hands](https://developers.google.com/mediapipe) — 手部 21 关键点识别
- [GLTFLoader](https://threejs.org/docs/) — 加载解剖模型
- [Vite](https://vitejs.dev/) 兼容（纯静态页面，任意静态服务器可托管）

## 📦 模型来源与许可

本项目使用的 3D 解剖模型基于以下开源数据集裁剪生成（仅保留左侧前臂与手部）：

| 数据源 | 内容 | 许可 |
|--------|------|------|
| **[BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html)**（日本 DBCLS，MRI 扫描数据重建） | 骨骼与肌肉网格 | [CC BY-SA 2.1 日本](https://creativecommons.org/licenses/by-sa/2.1/jp/) |
| **[Z-Anatomy](https://github.com/Z-Anatomy/Z-Anatomy)** | 补充肌肉网格 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

**模型裁剪来源**：[JohanBellander/BodyExplorer](https://github.com/JohanBellander/BodyExplorer) —— 一个开源的 3D 人体解剖查看器（Three.js），其模型数据同样基于上述数据集。

裁剪脚本见 `tools/extract_forearm.js`（基于 @gltf-transform，可按需修改保留部位）。

## 📜 许可说明

- **模型数据**：遵循上游数据源许可（BodyParts3D：CC BY-SA 2.1 JP；Z-Anatomy：CC BY-SA 4.0），署名要求见上表
- **本项目代码**：MIT License（见 [LICENSE](LICENSE)），模型文件除外
- 本工具为**教学演示用途**，3D 模型为解剖示意，不构成任何医学诊断依据

## 🗂 项目结构

```
ar_forearm/
├── index.html           # 页面入口
├── style.css            # 样式
├── app.js               # 核心逻辑（识别/渲染/联动高亮）
├── forearm_bones.glb    # 骨骼模型（28 块，左前臂+手）
├── forearm_muscles.glb  # 肌肉模型（32 块，左前臂+手）
└── tools/
    └── extract_forearm.js  # 模型裁剪脚本
```

## ⚠️ 已知限制

- 当前仅包含**左侧**前臂与手部（右侧模型可通过裁剪脚本生成）
- 肌肉联动高亮基于手势角度阈值判断，不同手型/光线条件下灵敏度可能需要微调
- 模型为静态网格，不含肌肉实时形变（教学上以高亮代替）
- 首次使用需授予摄像头权限

## 📌 路线图

- [ ] 中文肌肉/骨骼标注（点击显示名称与功能）
- [ ] 右侧肢体模型
- [ ] 分层拆解教学模式（皮肤→浅层肌→深层肌→骨骼）
- [ ] 骨骼关节联动（手指屈伸驱动骨骼旋转）
