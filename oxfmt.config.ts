import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["dist", "build", "node_modules", "apps/web/dist", "**/*.test.ts"],
  printWidth: 120,
  tabWidth: 2,
  overrides: [
    {
      files: ["*.md", "*.html"],
      options: {
        tabWidth: 4,
      },
    },
  ],
});
