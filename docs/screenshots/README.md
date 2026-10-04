# README 截图来源

这里的截图均由本项目的自动化验收生成，输入为合成记录，不包含实际患者日记。

- `home-saved.png`：`tests/installer-lifecycle.mjs` 在独立安装目录和数据目录新建空日记，保存一条当日仅日期记录后的界面。
- `report-monthly.png`、`report-calendar.png`：`tests/e2e/charts.spec.js` 使用 `tests/e2e/fixtures.js` 中的 `reportChartCase()`，导出医生报告并生成实际 A4 PDF，再用 Poppler 渲染第1页和第2页。

图表输入范围为2023-12-30至2024-02-02，5条合成头痛记录。按月新记录次数为3、1、1；跨年延续、无头痛确认和未记录日期都来自明确的测试输入。姓名未填写，评分与用药内容同样是测试构造。

截图像素没有重新绘制或改写，日期与数字可与夹具及图表测试复算。界面属于项目自身内容，随项目按 MIT 许可证分发。
