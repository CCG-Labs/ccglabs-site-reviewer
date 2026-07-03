import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "docs/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "child_process", message: "No subprocesses in runtime code." },
            { name: "node:child_process", message: "No subprocesses in runtime code." },
          ],
        },
      ],
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
