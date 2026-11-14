/**
 * Commitlint configuration.
 *
 * Allowed types are the repository's Conventional Commit set. The scope is
 * optional; the subject must be lowercase, imperative, and have no trailing
 * period. Merge/revert/fixup commits are ignored by commitlint's defaults.
 */
export default {
  rules: {
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],
    "header-max-length": [2, "always", 100],
    "header-trim": [2, "always"],
    "scope-case": [2, "always", "lower-case"],
    "subject-case": [2, "always", ["lower-case"]],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "type-enum": [2, "always", ["feat", "fix", "refactor", "test", "docs", "perf", "chore", "ci"]],
  },
};
