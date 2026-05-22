# Progress, Lessons and Learnings | 项目进度、经验与教训

## Project Overview / 项目概述
Extract the "Google Street View Virtual Tour Guide" (`street-walk` mode) from the Aeva project and create a standalone, minimal Web App directly in the workspace root directory.
从 Aeva 项目中提取“Google 街景虚拟导游”（`street-walk` 模式），并在工作区根目录中直接创建一个独立的、极简的 Web 应用程序。

---

## Progress Tracking / 进度跟踪

### Phase 1: Project Skeleton / 第一阶段：项目骨架
- [x] Configured basic workspace configuration files: `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `Dockerfile`, `index.html`.
  配置了基本的工作区配置文件。
- [x] Configured environment file `.env.local` containing only `GEMINI_API_KEY` and `VITE_GOOGLE_MAPS_API_KEY`.
  配置了只包含 `GEMINI_API_KEY` 和 `VITE_GOOGLE_MAPS_API_KEY` 的环境变量文件。
- [x] Copied frontend modules: `src/config.ts`, `src/lib/map_tools.ts`, `src/index.css`, `src/main.tsx`, and `src/vite-env.d.ts`.
  复制了前端的核心支撑模块。
- [x] Created `src/components/StreetWalkPanorama.tsx` from original `ImmersionPanels.tsx` and updated imports.
  从原始面板中提取并创建了 `StreetWalkPanorama.tsx`。

### Phase 2: Backend Simplification / 第二阶段：后端简化
- [x] Implemented simplified WebSocket proxy server `gemini-ws.js` with inlined instructions and `navigate`/`teleport` tool declarations. Removed Supabase dependency.
  实现了简化的 WebSocket 代理服务器 `gemini-ws.js`，内联了指令与 `navigate`/`teleport` 工具声明，移除了 Supabase 依赖。
- [x] Implemented production startup server `index.js`.
  实现了生产环境启动服务 `index.js`。
- [x] Configured Dev Mode config in `vite.config.ts`.
  配置了开发模式的 `vite.config.ts`。

### Phase 3: Frontend Core / 第三阶段：前端核心
- [x] Create `src/utils.ts` and `src/utils.test.ts` (copying helper functions).
  创建 `src/utils.ts` 和 `src/utils.test.ts`（复制辅助函数）。
- [x] Create `src/App.tsx` containing the simplified single-mode structure (tour guide viewport, controls, transcript).
  创建 `src/App.tsx`，包含简化的单模式结构（导游视口、控制栏、转录文本）。
- [x] Install dependencies and verify build.
  安装依赖项并验证构建。
- [x] Run unit tests and verify everything is working.
  运行单元测试并验证一切正常。

### Phase 4: Verification and Clean Up / 第四阶段：验证与清理
- [x] Fixed TypeScript compiler checks by adding `"exclude": ["Aeva", "node_modules"]` in `tsconfig.json`.
  通过在 `tsconfig.json` 中添加 `"exclude": ["Aeva", "node_modules"]` 修复了 TypeScript 编译检查。
- [x] Configured Vitest to run only project-specific tests and exclude `Aeva` using `"test": "vitest run --exclude **/Aeva/**"` in `package.json`.
  在 `package.json` 中配置了 `"test": "vitest run --exclude **/Aeva/**"`，以仅运行当前项目的单元测试。
- [x] Verified `npm run typecheck`, `npm run test`, and `npm run build` all pass successfully.
  验证了 `npm run typecheck`、`npm run test` 和 `npm run build` 全部成功通过。

---

## Lessons and Learnings / 经验与教训
1. **Tool declarations**: Gemini Live API manages client-side tool execution by passing them to the WebSocket client as a `client_tool_request` message type. The frontend intercepts and executes these calls on the panorama instance before sending the result back.
   **工具声明**：Gemini Live API 通过在 WebSocket 连接中作为 `client_tool_request` 消息发送给客户端来管理客户端工具的执行。前端拦截并在街景实例上执行这些调用，然后再将结果发送回。
2. **Audio pipeline**: Gemini Live relies on Raw PCM 16-bit 16kHz audio input and 24kHz audio output. Synchronizing transcripts and audio playback timing avoids stutter and overlapping speech.
   **音频管道**：Gemini Live 依赖 Raw PCM 16-bit 16kHz 音频输入与 24kHz 音频输出。同步字幕和音频播放时间可避免卡顿和重叠语音。
3. **TypeScript and Vitest Path Scopes**: When extracting files to a sub-folder or sibling folder inside a larger repository, compiler and test runners (like `tsc` and `vitest`) may recursively check both old and new codebases by default. Defining explicit exclusion rules prevents type collision and test clutter.
   **TypeScript 和 Vitest 路径范围限制**：在大型仓库中将文件提取到子文件夹时，编译器和测试运行器（如 `tsc` 和 `vitest`）默认可能会递归检查新旧两个代码库。定义明确的排除规则可防止类型冲突和测试干扰。

### Phase 5: Rebranding & Git Cleanup / 第五阶段：品牌重塑与 Git 历史清理
- [x] Renamed product to Vista: "Roam the world from your screen."
  将产品更名为 Vista: "Roam the world from your screen."
- [x] Performed full codebase search and rebranding of all code variables, dialogue transcript labels, and HTML page configurations.
  在整个代码库中对所有代码变量、对话转录标签和 HTML 页面配置进行了品牌重写。
- [x] Updated configuration files (`package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`) to remove the workarounds/exclusions for the legacy `Aeva` directory.
  更新了配置文件以删除遗留 `Aeva` 目录的变通方法/排除项。
- [x] Cleaned up Git history to completely remove any trace of `proposal.md` or the legacy `Aeva` folder.
  清理了 Git 历史，彻底移除了 `proposal.md` 和遗留 `Aeva` 文件夹的所有痕迹。
- [x] Verified build correctness using production bundling, typecheck, and unit test runners.
  使用生产打包、类型检查和单元测试运行器验证了构建的正确性。
