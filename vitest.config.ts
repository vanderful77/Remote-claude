import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // 集成测试会起真实端口和 tmux，串行跑避免互相干扰
    fileParallelism: false,
  },
});
