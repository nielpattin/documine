import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "import"],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  env: {
    builtin: true,
    browser: true,
  },
  ignorePatterns: ["dist/**", "node_modules/**", "apps/web/dist/**", "**/*.test.ts", "apps/web/tsconfig.app.json"],
  rules: {
    "eslint/no-control-regex": "off",
    "unicorn/no-useless-spread": "off",
    "typescript/no-base-to-string": "off",
  },
});
