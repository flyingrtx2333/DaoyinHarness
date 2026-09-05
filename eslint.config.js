import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", ".cache/**", "claude-code-main/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
