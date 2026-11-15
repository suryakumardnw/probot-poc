import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Temporary element type for the top-level directories that have not moved into
 * `src/modules` or `src/platform` yet. Every path here is listed with its
 * removal PR in docs/module-boundaries.md; PR 3.12 deletes this list.
 */
const LEGACY_ELEMENT_PATHS = [
  "src/admin",
  "src/agent",
  "src/config",
  "src/controllers",
  "src/eval",
  "src/execution",
  "src/knowledge",
  "src/lib",
  "src/models",
  "src/observability",
  "src/publishing",
  "src/review-engine",
  "src/services",
  "src/views",
];

/**
 * Temporary `process.env` allowances. `platform/config` owns environment
 * parsing, tests may arrange their own environment, and the one-off deploy
 * diagnostic runs outside the application. Every other entry names the move PR
 * and PR 3.12 as its explicit final removal: the reads survive move-only PRs.
 */
const PROCESS_ENV_ALLOWED_FILES = [
  "src/platform/config/**/*.ts",
  "test/**/*.ts",
  // One-off container diagnostic; not application code (permanent exception).
  "deploy/inspect-key.js",
  // TODO(PR 3.10; PR 3.12 final): config moves to platform/config.
  "src/config/**/*.ts",
  // TODO(PR 3.10; PR 3.12 final): composition roots read operational overrides.
  "src/bootstrap/**/*.ts",
  // TODO(PR 3.11; PR 3.12 final): CLI scripts read environment directly.
  "src/scripts/**/*.ts",
  // TODO(PR 3.6; PR 3.12 final): admin moves into a module.
  "src/admin/**/*.ts",
  // TODO(PR 3.9; PR 3.12 final): agent runtimes move to platform/agents.
  "src/agent/**/*.ts",
  // TODO(PR 3.8; PR 3.12 final): execution moves into a module.
  "src/execution/**/*.ts",
  // TODO(PR 3.8; PR 3.12 final): knowledge moves into a module.
  "src/knowledge/**/*.ts",
  // TODO(PR 3.9; PR 3.12 final): model adapters move to platform/models.
  "src/models/**/*.ts",
  // TODO(PR 3.10; PR 3.12 final): observability moves to platform/observability.
  "src/observability/**/*.ts",
  // TODO(PR 3.5; PR 3.12 final): publishing moves into a module.
  "src/publishing/**/*.ts",
  // TODO(PR 3.7; PR 3.12 final): triage services move into a module.
  "src/services/**/*.ts",
  // TODO(PR 3.12): the workspace module still reads GitHub App credentials
  // from the environment in its token provider.
  "src/modules/workspace/**/*.ts",
];

/**
 * Temporary Prisma type allowances. Repository adapters and `platform/db` own
 * Prisma; these files still hold vendor types because their move PR is
 * move-only. PR 3.12 removes whatever survives its move PR.
 */
const PRISMA_ALLOWED_FILES = [
  "src/**/*.repository.ts",
  "src/platform/db/**/*.ts",
  "test/**/*.ts",
  // TODO(PR 3.10): lib/prisma.ts becomes platform/db/prisma.ts.
  "src/lib/prisma.ts",
  // TODO(PR 3.10): health is a platform adapter.
  "src/lib/health.ts",
  // TODO(PR 3.10): the composition root should consume platform/db factories.
  "src/bootstrap/clients.ts",
  // TODO(PR 3.8): knowledge moves into a module; PR 3.12 removes this.
  "src/knowledge/materialize.ts",
  // TODO(PR 3.8): execution moves into a module; PR 3.12 removes this.
  "src/execution/service.ts",
  // TODO(PR 3.11): eval moves under scripts; PR 3.12 removes this.
  "src/eval/persistence.ts",
];

/**
 * Temporary `fetch` allowances. Only the platform layer may perform network
 * I/O; knowledge and triage still own their HTTP clients until their move PRs.
 */
const FETCH_ALLOWED_FILES = [
  "src/platform/**/*.ts",
  // TODO(PR 3.6): the admin OAuth client moves into the admin module behind a
  // GitHub identity port.
  "src/admin/**/*.ts",
  // TODO(PR 3.8): knowledge moves into a module; PR 3.12 replaces this with a
  // platform-owned model/knowledge client.
  "src/knowledge/**/*.ts",
  // TODO(PR 3.7): triage moves to the model-provider port.
  "src/services/**/*.ts",
];

/**
 * ESLint flat config.
 *
 * Rules are intentionally enabled now, before the structural refactor, so new
 * violations cannot land. The test and source overrides below are temporary and
 * tracked by PR 4.2.
 *
 * Import boundaries are a scaffold: the target policies are active, while
 * `legacy` elements and the path lists above keep the current top-level layout
 * lint-clean. Each allowance and its removal PR is recorded in
 * docs/module-boundaries.md.
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
    // `bootstrap`. Policies below are the target rules; temporary allowances
    // are separate, commented entries whose removal PRs live in
    // docs/module-boundaries.md.
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
        { type: "legacy", pattern: LEGACY_ELEMENT_PATHS, partialMatch: false },
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
              // TODO(PR 3.4/3.9/3.10): modules still reach un-moved top-level
              // directories directly. Each path is removed when its directory
              // moves (or becomes a port-backed platform adapter).
              from: { element: { type: "module" } },
              allow: {
                to: {
                  element: {
                    type: "legacy",
                    path: ["src/agent", "src/config", "src/observability", "src/review-engine"],
                  },
                },
              },
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
              // TODO(PR 3.10): ports/review-config still re-exports the concrete
              // loader error; the loader moves to platform/config.
              from: { element: { type: "ports" } },
              allow: { to: { element: { type: "legacy", path: "src/config" } } },
            },
            {
              // Shared code may use the Zod contracts; it must not import
              // modules, platform, ports, bootstrap, scripts, or tests.
              from: { element: { type: "shared" } },
              allow: { to: { element: { type: "contracts" } } },
            },
            {
              // TODO(PR 3.4): contracts/review.ts still reads the finding
              // categories from review-engine/types.ts.
              from: { element: { type: "contracts", fileInternalPath: "review.ts" } },
              allow: { to: { element: { type: "legacy", path: "src/review-engine" } } },
            },
            {
              // TODO(PR 3.12): delete with LEGACY_ELEMENT_PATHS. Until each
              // directory moves, legacy code keeps its current imports.
              from: { element: { type: "legacy" } },
              allow: { to: { element: { type: "*" } } },
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
    // Approved exceptions for the rules above. Every temporary entry is listed
    // with its removal PR in docs/module-boundaries.md.
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
