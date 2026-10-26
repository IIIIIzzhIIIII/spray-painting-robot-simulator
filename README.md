# 智能墙面喷涂机器人仿真系统

室内墙面喷涂 · 六轴机械臂数字孪生。纯前端、零依赖安装，打开网页即可运行。

**在线体验：<https://iiiiizzhiiiii.github.io/spray-painting-robot-simulator/>**

> 页面右上角的 `QR` 按钮会基于当前访问地址生成二维码，手机扫码即可在移动端打开本系统（建议横屏）。

## 功能概览

- **六轴关节控制**：J1–J6 关节滑块、角度限位保护、快捷姿态一键到达。
- **喷涂工艺**：QZDS 001–024 涂料参数库、自适应工艺（按涂层与选区自动匹配压力/扇幅/膜厚/走枪速度）、工艺参数与工艺模板。
- **示教与轨迹**：记录点位、轨迹回放、轨迹命名保存（保存在浏览器 `localStorage`，刷新后仍在）。
- **仿真效果**：喷涂粒子、喷嘴特写、模型图层显隐、深色主题、全屏显示。
- **数据导出**：作业面积与统计表格，一键导出 CSV。
- **自定义模型**：支持导入本地 `.glb / .gltf` 机械臂（约定：Y 轴向上、单位米、Z 轴朝前，节点名 `J1`–`J6`），可一键恢复内置模型。

## 技术栈

- [Three.js](https://threejs.org/) r160（`js/lib/three.min.js` + OrbitControls / GLTFLoader / BufferGeometryUtils）
- [Vue 3](https://vuejs.org/) + [Element Plus](https://element-plus.org/)（全局构建版，本地引入）
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（页面内二维码）
- 全部第三方库均以本地文件形式随仓库分发，**无需外网 CDN，可离线运行**。

## 本地运行

ES Module / 资源加载需要通过 HTTP 访问，直接双击 `index.html` 可能出现限制，建议起一个静态服务器：

```bash
# 方式一：Python（已安装 Python 3）
python -m http.server 8080

# 方式二：Node.js
npx serve .
```

然后浏览器打开 <http://localhost:8080/>。

## 目录结构

```
index.html                        页面结构（单页应用）
css/style.css                     主样式
css/lib/element-plus.css          Element Plus 样式
js/app.js                         应用装配与主流程
js/config.js                      涂料库、工艺模板、默认参数
js/scene.js                       场景、相机、灯光、墙面与地面
js/robot.js                       六轴机械臂建模、运动学、GLB 导入
js/spray.js                       喷涂粒子、膜厚与覆盖效果
js/nozzle.js                      喷嘴特写与扇幅可视化
js/tool.js                        工具与末端执行器
js/teach.js                       示教点位与轨迹存储
js/ui.js                          面板交互、统计、二维码分享
js/lib/                           第三方库（Three.js / Vue / Element Plus / QR）
.github/workflows/deploy-pages.yml  GitHub Pages 自动部署
```

## 部署

推送到 `main` 即自动触发 GitHub Actions 部署到 GitHub Pages：

1. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**（本仓库已开启）。
2. 每次 `main` 有新提交，`.github/workflows/deploy-pages.yml` 会把 `index.html`、`css/`、`js/`、`.nojekyll` 打包为 Pages 产物并发布。
3. 也可在 **Actions → Deploy static site to GitHub Pages → Run workflow** 手动触发。

## 说明

- 本项目为教学/演示用途的仿真软件，喷涂参数与工艺模板为典型值示例，不能直接用于现场设备调试。
- 机械臂模型为程序化生成的内置模型；导入自定义 GLB 时请遵循上述节点命名与坐标约定。
