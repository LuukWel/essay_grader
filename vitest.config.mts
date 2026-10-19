import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test file gets its own in-memory SQLite database (see src/server/db/client.ts).
    env: { GRADING_DB_PATH: ':memory:' },
  },
});
