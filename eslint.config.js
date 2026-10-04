import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Storage APIs must never hold credentials (docs/DESIGN.md §22.2).
const forbiddenStorage = ["localStorage", "sessionStorage", "indexedDB"];
const storageMessage = "Persistent browser storage is forbidden (credentials / post data). See docs/DESIGN.md §22.2.";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": "error",
      "no-restricted-globals": [
        "error",
        ...forbiddenStorage.map((name) => ({ name, message: storageMessage })),
      ],
      "no-restricted-properties": [
        "error",
        ...["window", "globalThis", "self"].flatMap((object) =>
          forbiddenStorage.map((property) => ({ object, property, message: storageMessage })),
        ),
        { object: "document", property: "cookie", message: storageMessage },
      ],
    },
  },
  {
    files: ["src/infra/logger.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
