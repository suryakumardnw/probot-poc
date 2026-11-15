import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint flat config.
 *
 * Rules are intentionally enabled now, before the structural refactor, so new
 * violations cannot land. The test and source overrides below are temporary and
 * tracked by PR 4.2.
 */
export default tseslint.config(
  {
    ignores: ["lib/", "node_modules/", "coverage/", "prisma/migrations/", ".superpowers/", "*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
        },
        node: {
          extensions: [".js", ".mjs", ".cjs", ".ts", ".json"],
        },
      },
      "import/extensions": [".js", ".mjs", ".cjs", ".ts", ".json"],
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          // `import("...").T` annotations are type queries, not imports.
          disallowTypeAnnotations: false,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "import/no-cycle": ["error", { maxDepth: Infinity }],
      "import/order": [
        "error",
        {
          alphabetize: { order: "asc", caseInsensitive: true },
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "ignore",
        },
      ],
      "no-console": "error",
    },
  },
  {
    // CLI entry points print to stdout/stderr by design.
    files: ["src/scripts/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // One-off container diagnostic that runs as CommonJS outside the package.
    files: ["deploy/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
    },
  },
  {
    // TODO(PR 4.2): delete this block. These files hold the 28 non-null
    // assertions recorded in docs/typescript-refactor-baseline.md. Replacing
    // them changes admin auth, command execution, and worker shutdown control
    // flow, so it is out of scope for the tooling PR. The rule stays on for
    // every other source file, and PR 4.2 removes the remaining assertions.
    files: [
      "src/admin/api.ts",
      "src/admin/github-client.ts",
      "src/admin/panel.ts",
      "src/admin/rate-limit.ts",
      "src/admin/session.ts",
      "src/config/review-loader.ts",
      "src/execution/local-executor.ts",
      "src/execution/policy.ts",
      "src/modules/findings/validation.ts",
      "src/modules/webhooks/issue-comment.ts",
      "src/observability/alerts.ts",
      "src/publishing/summary.ts",
      "src/review-engine/retrieval.ts",
      "src/review-engine/tools.ts",
      "src/worker.ts",
    ],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // TODO(PR 4.2): remove both overrides once fakes replace the real
      // Postgres/Redis fixtures. Test bodies assert known-good fixtures with
      // `!` and construct partial `any` values; fixing them belongs to the
      // fakes migration, not the tooling PR.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  prettier,
  {
    // eslint-config-prettier disables `curly` because the two tools can
    // disagree about one-line bodies. Re-enable it after Prettier so braces are
    // still mandatory; Prettier formats the resulting blocks.
    rules: {
      curly: ["error", "all"],
    },
  },
);
