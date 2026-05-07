import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      // agent-runner tests use bun:test — run via 'bun test' in container/agent-runner/
      'dashboard/**/*.test.ts',
    ],
    testTimeout: 15000,
  },
});
