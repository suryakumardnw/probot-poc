import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Approved vendor and environment exceptions. These are architectural
 * decisions, not migration scaffolding:
 * - Repository adapters and `platform/db` own Prisma.
 * - Tests may arrange the process environment and assert against vendor row
 *   types; tests are never application code.
 * - `platform/config` is the only production reader of the process
 *   environment.
 * - The one-off deploy diagnostic runs outside the application and reads the
 *   mounted key on purpose.
 * - Network I/O belongs to `platform`.
 *
 * Every exception is documented in docs/module-boundaries.md.
 */
const PRISMA_ALLOWED_FILES = ["src/**/*.repository.ts", "src/platform/db/**/*.ts", "test/**/*.ts"];

const PROCESS_ENV_ALLOWED_FILES = ["src/platform/config/**/*.ts", "test/**/*.ts", "deploy/inspect-key.js"];

const FETCH_ALLOWED_FILES = ["src/platform/**/*.ts"];

/**
 * ESLint flat config.
 *
 * Boundary rules are mandatory: there is no temporary allowance left from the
 * Phase 3 moves. The test and non-null overrides below are tracked separately
 * by PR 4.2 (typescript-refactor baseline).
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
    // Module boundaries. Element patterns are anchored at the repository root;
    // the first matching descriptor wins, so module/platform/etc. are listed
    // before the broad `src` fallback that classifies entry points as
    // `bootstrap`.
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"],
    plugins: {
      boundaries,
    },
    settings: {
      // First matching descriptor wins; keep this explicit rather than relying
      // on the plugin default.
      "boundaries/elements-single-match": true,
      "boundaries/elements": [
        { type: "module", pattern: "src/modules/*", capture: ["moduleName"], partialMatch: false },
        { type: "bootstrap", pattern: "src/bootstrap", partialMatch: false },
        { type: "platform", pattern: "src/platform", partialMatch: false },
        { type: "contracts", pattern: "src/contracts", partialMatch: false },
        { type: "ports", pattern: "src/ports", partialMatch: false },
        { type: "shared", pattern: "src/shared", partialMatch: false },
        { type: "script", pattern: ["src/scripts", "scripts"], partialMatch: false },
        { type: "test", pattern: "test", partialMatch: false },
        // Entry points (`src/index.ts`, `src/server.ts`, `src/worker.ts`) are
        // the only files whose element resolves to the repository `src` folder.
        { type: "bootstrap", pattern: "src", partialMatch: false },
      ],
      "boundaries/files": [{ pattern: "**/*.test.ts", category: "test" }],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          // External packages are not architectural layers. Contracts are the
          // exception: they may only depend on Zod. Test files are exempt from
          // contracts' external allowlist (they may import vitest/node APIs).
          checkAllOrigins: true,
          policies: [
            {
              allow: { to: { module: { origin: ["external", "core"] } } },
            },
            {
              from: { element: { type: "contracts" } },
              disallow: { to: { module: { origin: ["external", "core"] } } },
            },
            {
              from: { element: { type: "contracts" } },
              allow: { to: { module: { origin: "external", source: "zod" } } },
            },
            {
              // Composition roots may import every layer.
              from: { element: { type: "bootstrap" } },
              allow: { to: { element: { type: "*" } } },
            },
            {
              // Tooling may import application code.
              from: { element: { type: "script" } },
              allow: { to: { element: { type: "*" } } },
            },
            {
              // A module sees contracts, ports, shared, its own internals
              // (internal dependencies are not checked), and other modules'
              // public entry points only.
              from: { element: { type: "module" } },
              allow: { to: { element: { type: ["contracts", "ports", "shared"] } } },
            },
            {
              from: { element: { type: "module" } },
              allow: { to: { element: { type: "module", fileInternalPath: "index.ts" } } },
            },
            {
              // Platform adapters may use contracts, ports, and shared only.
              from: { element: { type: "platform" } },
              allow: { to: { element: { type: ["contracts", "ports", "shared"] } } },
            },
            {
              from: { element: { type: "ports" } },
              allow: { to: { element: { type: ["contracts", "shared"] } } },
            },
            {
              // Shared code may use the Zod contracts; it must not import
              // modules, platform, ports, bootstrap, scripts, or tests.
              from: { element: { type: "shared" } },
              allow: { to: { element: { type: "contracts" } } },
            },
            {
              // Tests (including co-located `*.test.ts` files) may import any
              // layer and test helper.
              from: [{ element: { type: "test" } }, { file: { categories: "test" } }],
              allow: {
                to: [{ element: { type: "*" } }, { module: { origin: ["external", "core"] } }],
              },
            },
          ],
        },
      ],
    },
  },
  {
    // Vendor and environment boundaries. These are architectural rules too, so
    // they live with the boundary scaffold instead of a one-off CI grep. Root
    // scripts and the deploy diagnostic are tooling, but still linted; the
    // deploy process.env exception is documented in docs/module-boundaries.md.
    files: ["**/*.{ts,mts,cts}", "scripts/**/*.mjs", "deploy/**/*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message:
                "Import Prisma only from *.repository.ts adapters or src/platform/db (see docs/module-boundaries.md).",
            },
          ],
          patterns: [
            {
              group: ["@prisma/client/*"],
              message:
                "Import Prisma only from *.repository.ts adapters or src/platform/db (see docs/module-boundaries.md).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "Read environment configuration through src/platform/config (see docs/module-boundaries.md).",
        },
        {
          selector: "MemberExpression[object.name='process'][computed=true][property.value='env']",
          message: "Read environment configuration through src/platform/config (see docs/module-boundaries.md).",
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Network I/O belongs to src/platform; depend on a port instead (see docs/module-boundaries.md).",
        },
      ],
    },
  },
  {
    // Approved exceptions for the vendor rules above. The permanent entries are
    // documented in docs/module-boundaries.md.
    files: PRISMA_ALLOWED_FILES,
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: PROCESS_ENV_ALLOWED_FILES,
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    files: FETCH_ALLOWED_FILES,
    rules: {
      "no-restricted-globals": "off",
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
      "src/modules/admin/admin.auth.http.ts",
      "src/modules/admin/auth/github-oauth.ts",
      "src/modules/admin/auth/session.ts",
      "src/modules/admin/rate-limit.ts",
      "src/platform/config/review-loader.ts",
      "src/modules/execution/local-executor.ts",
      "src/modules/execution/policy.ts",
      "src/modules/findings/validation.ts",
      "src/modules/webhooks/issue-comment.ts",
      "src/platform/observability/alerts.ts",
      "src/modules/publishing/summary.ts",
      "src/modules/review/retrieval.ts",
      "src/modules/review/tools.ts",
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
