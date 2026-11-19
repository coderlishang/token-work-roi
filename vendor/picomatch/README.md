# picomatch（本地补丁版）

- 来源：picomatch 4.0.7（MIT），只保留运行时文件
- 补丁：回移 micromatch/picomatch#237，修复 CVE-2026-112366（单分支重复 extglob 回溯爆炸）
- 版本记为 4.0.8：官方 4.0.7 无修复版，npm audit 受影响范围为 ≤4.0.7
- 由根目录 `workspaces` 链接给 vite 使用；上游发布正式修复版后删除本目录并移除该声明
