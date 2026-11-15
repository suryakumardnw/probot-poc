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
const PRISMA_ALLOWED_FILES = ["src/**/*.repository.ts", "src/platform/db/**/*.ts"];

const PROCESS_ENV_ALLOWED_FILES = ["src/platform/config/**/*.ts", "test/**/*.ts", "deploy/inspect-key.js"];

const FETCH_ALLOWED_FILES = ["src/platform/**/*.ts"];

/**
 * Vendor imports belong to the platform adapter that owns them. Modules,
 * ports, contracts, and shared code depend on ports instead.
 */
const VENDOR_IMPORT_MESSAGES = {
  "@prisma/client":
    "Import Prisma only from *.repository.ts adapters or src/platform/db (see docs/module-boundaries.md).",
  bullmq: "Import BullMQ only from src/platform/queue (see docs/module-boundaries.md).",
  ioredis: "Import ioredis only from src/platform (see docs/module-boundaries.md).",
  "@octokit/auth-app": "Import GitHub App auth only from src/platform/github (see docs/module-boundaries.md).",
  "@octokit/core": "Import Octokit only from src/platform/github (see docs/module-boundaries.md).",
  "@octokit/plugin-rest-endpoint-methods":
    "Import Octokit only from src/platform/github (see docs/module-boundaries.md).",
  "@octokit/plugin-retry": "Import Octokit only from src/platform/github (see docs/module-boundaries.md).",
};

const PRISMA_IMPORT_MESSAGE = VENDOR_IMPORT_MESSAGES["@prisma/client"];

/**
 * Build the `no-restricted-imports` rule, allowing the named vendor packages
 * for one adapter directory while keeping every other vendor boundary.
 */
function restrictedImports(allowedNames = []) {
  return [
    "error",
    {
      paths: Object.entries(VENDOR_IMPORT_MESSAGES)
        .filter(([name]) => !allowedNames.includes(name))
        .map(([name, message]) => ({ name, message })),
      patterns: [{ group: ["@prisma/client/*"], message: PRISMA_IMPORT_MESSAGE }],
    },
  ];
}

/**
 * ESLint flat config.
 *
 * Boundary rules are mandatory: there is no temporary allowance left from the
 * Phase 3 moves. The former source and test non-null/`any` overrides were
 * retired by PR 4.2; only the frozen characterization suite keeps a narrow
 * allowance because its assertions are the black-box baseline and must not be
 * edited.
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
      "no-restricted-imports": restrictedImports(),
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
      "no-restricted-imports": restrictedImports(["@prisma/client"]),
    },
  },
  {
    // The queue adapter is the only owner of the BullMQ/ioredis clients.
    files: ["src/platform/queue/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(["bullmq", "ioredis"]),
    },
  },
  {
    // The shared Redis client factory is the only other ioredis owner.
    files: ["src/platform/redis.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(["ioredis"]),
    },
  },
  {
    // The GitHub transport adapters own the Octokit packages.
    files: ["src/platform/github/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports([
        "@octokit/auth-app",
        "@octokit/core",
        "@octokit/plugin-rest-endpoint-methods",
        "@octokit/plugin-retry",
      ]),
    },
  },
  {
    // Tests may arrange vendor clients and assert against vendor row types;
    // tests are never application code (docs/module-boundaries.md).
    files: ["test/**/*.ts"],
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
    // The characterization suite is the frozen behavioural baseline: its
    // assertions intentionally read known-good fixture rows with `!` and
    // construct partial vendor-shaped values. PR 4.2 must not rewrite those
    // files (acceptance criterion), so the allowance stays scoped to them.
    // Unit, contract, integration and helper code are fully checked.
    files: ["test/characterization/**/*.ts"],
    rules: {
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
