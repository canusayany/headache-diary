# 头痛记录 · Headache Diary

给头痛时不想多操作的人：打开桌面图标，点一次 **「记一次头痛」**，看到保存成功就可以关窗休息。

这是一个本地运行的网页应用，提供 Windows 安装包、暗色界面、日历回看和就诊报告。当前版本为 **1.3.0**，应用源代码采用 [MIT 许可证](LICENSE)。

## 为患者减少操作

- 一次头痛只需一次点击，没有必填项、确认弹窗或必须再点的结束按钮。
- 默认暗色、大按钮；疼痛程度、症状、用药和实际起止时间可等有余力时再补。
- 一键记录只确认当天发生过头痛，不把登记时间当成发作开始时间，不猜测持续多久或是否结束。
- 保存失败会明确提示；重试沿用同一条记录，避免重复登记。

## 回看和就诊

- 每日日历显示哪天头痛、当天记录几次，点日期看明细。
- 月度柱状图分别显示记录次数、头痛天数和未记录天数；可选近 28 / 56 / 90 天、近 6 个自然月或自定义范围。
- 同一天多条记录分别计次，跨日延续只在开始日计一次；没有记录的日子不能当作无头痛。
- 导出独立 HTML、打印或保存 PDF、导出 CSV 明细；完整 JSON 备份可用于恢复日记。

详细操作见 [使用说明](使用说明.md)。统计定义和设计参考见 [图表设计说明](图表设计说明.md)。这些图表用于表达患者自述，参考官方资料不表示软件获得 FDA 等机构认证、批准或认可。软件不自动诊断，也不提供治疗或用药建议。

## 安装使用

普通使用者可从 [最新发布版本](https://github.com/canusayany/headache-diary/releases/latest) 下载 Windows x64 安装包，按 [安装说明](安装说明.md) 安装，然后从桌面「头痛记录」图标打开。安装包内置 Node.js 运行时，日常使用无需安装开发工具或连接互联网，需要电脑已有 Microsoft Edge 或 Google Chrome。

安装版按当前 Windows 用户安装，无需管理员权限。记录保存在 `%LOCALAPPDATA%\HeadacheDiary\data`；升级保留数据，卸载也保留该数据文件夹。开发版与安装版数据目录不同，迁移请先导出完整 JSON 备份，再在目标版本核对并恢复。

兼容目标为 Windows 10 / 11 x64。目前实际验证环境为 **Windows 11 x64 + Microsoft Edge**，未在另外的 Windows 10 或 Chrome 机器上实测。1.3.0 安装程序尚未进行发布者数字签名；请核对下载来源及随发布提供的 SHA-256 校验值。

## 从源码运行

准备 Node.js 24.x 和 npm（本版本使用 Node.js 24.19.0 验证），下载或克隆仓库后，在项目目录运行：

```powershell
npm ci
npm start
```

在浏览器打开 <http://127.0.0.1:17843/>。服务只监听本机地址，记录默认写入项目内 `data/state.json`，修改前的最近 30 份旧版本保存在 `data/backups`。停止服务可在运行它的终端按 `Ctrl+C`。

Windows 源码版可创建桌面快捷方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-desktop.ps1
```

之后从桌面图标启动，启动器会使用已安装的 Node.js。源码版快捷方式依赖项目原来的位置，请保留项目目录；该脚本会写入名为「头痛记录」的桌面快捷方式，已有同名快捷方式会被替换。

开发或试用时可选择独立的数据目录和端口，避免与日常日记混用：

```powershell
$env:HEADACHE_DATA_DIR = Join-Path $env:TEMP 'headache-diary-dev'
$env:HEADACHE_PORT = '17845'
npm start
```

然后打开 <http://127.0.0.1:17845/>。安装版使用 `127.0.0.1:17844`，启动器会检查服务身份，端口被其他实例占用时拒绝切换日记目录。

## 数据和隐私边界

健康记录保存在本机，不上传云端，界面及报告没有外部图表服务。自动旧版本与主记录仍在同一台电脑上，建议定期下载完整 JSON 备份并保存到另一位置。

本机服务没有账户登录或会话认证；服务开启时，同一电脑其他已登录账户也可能访问记录。请在可信电脑上使用。不要把自己的 `data/`、备份、报告或日志提交到公开仓库；仓库内的测试病例均为合成数据。PDF、HTML 和 CSV 是回看或就诊材料，恢复完整日记需使用 JSON 备份。

## 测试

```powershell
npm ci
npm test
npm run test:e2e
```

端到端测试使用本机已安装的 Microsoft Edge，不需要先启动日常记录服务。测试在独立目录、随机端口上运行合成日记，输出到被 Git 忽略的 `test-results/`。配置覆盖 1280px 桌面和 390px 暗色小窗口；部分 Windows 启动与文件占用测试在其他系统上会跳过。

1.3.0 的 Windows 11 本机验收结果：121 项单元及集成测试通过；端到端 81 项通过、1 项重复打印测试跳过。另已验证安装、升级、卸载和重装的数据保留。这是软件测试结果，尚未经过真实患者舒适度试用，不代表所有电脑的兼容性或速度保证。

## 构建 Windows 安装包

构建工具和生成文件不纳入源码仓库。需要准备：

1. 官方 Windows x64 Node.js 运行时目录，包含 `node.exe` 和未修改的完整 `LICENSE` 文件。本版本使用 v24.19.0。
2. 完整的 [Inno Setup](https://jrsoftware.org/isinfo.php) 安装目录，包含 `ISCC.exe` 及其相邻依赖。本版本使用 6.7.3；中文语言文件已放在 `installer/ChineseSimplified.isl`。

默认工具位置为 `build-tools/node-runtime/` 和 `build-tools/inno-setup/`，准备好后运行：

```powershell
npm run build:installer
```

也可明确指定自己的工具位置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -CompilerPath 'C:\tools\inno-setup\ISCC.exe' -RuntimeDirectory 'C:\tools\node-v24.19.0-win-x64'
```

输出为 `dist/HeadacheDiary-Setup-1.3.0-x64.exe` 和 `dist/SHA256SUMS.txt`。载荷由明确文件白名单生成，不读取患者 `data/`。只生成载荷可运行：

```powershell
npm run build:stage -- --runtime-dir 'C:\tools\node-v24.19.0-win-x64'
```

安装生命周期验收使用刚构建的安装包，需 Windows、Edge，以及没有安装此软件的专用测试账户：

```powershell
npm run test:installer
```

该测试会实际写入当前用户的安装登记，安装、升级、卸载和重装测试副本；发现已有安装登记时拒绝运行。请在专用测试环境执行，结果保存在 `output/installer-tests/`。测试当前核对内置 Node.js v24.19.0，改变运行时版本时需同步验收断言与第三方声明。

## 项目结构

| 文件或目录 | 职责 |
| --- | --- |
| `app.js`、`styles.css` | 患者界面和交互 |
| `model.js` | 数据校验、日期归属和统计 |
| `charts.js`、`reports.js` | 共用图表、就诊 HTML 和 CSV |
| `server.js` | 本机服务、串行保存、自动旧版本 |
| `launch.ps1`、`launch.vbs` | Windows 桌面启动 |
| `installer/`、`scripts/` | 安装器和载荷构建 |
| `tests/` | 单元、集成、浏览器及安装测试 |

## 贡献和许可证

欢迎提交问题或改进，先阅读 [贡献说明](CONTRIBUTING.md)。反馈中请使用合成病例，避免公开健康信息。

应用源代码采用 [MIT](LICENSE) 许可证。Node.js 及其组件、Inno Setup 中文语言文件保留各自许可证，详见 [第三方声明](THIRD-PARTY-NOTICES.txt)、[中文语言文件许可](installer/ChineseSimplified.LICENSE.txt) 和安装包中的 `runtime/LICENSE.txt`。
