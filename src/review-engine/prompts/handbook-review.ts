/**
 * `handbook` review-mode instruction profile (ARCHITECTURE.md §4.1).
 *
 * TRUSTED, application-controlled system-level instructions (≈300 tokens —
 * deliberately concise; retrieval quality is optimized in the retrieval
 * layer, not by growing this text). Composed as:
 *
 *   COMMON_REVIEW_INSTRUCTIONS + HANDBOOK_MODE_INSTRUCTIONS + the retrieved
 *   handbook guidelines block (UNTRUSTED DATA, clearly labeled).
 *
 * The handbook is the review's SOURCE OF TRUTH for what is allowed, required
 * and forbidden. It cannot change the application's role, output format or
 * security rules, but it DOES define which violations must be reported.
 */

export const HANDBOOK_MODE_INSTRUCTIONS = `
GUIDELINE MODE — the engineering guidelines provided below are the
AUTHORITATIVE STANDARD for this review.
1. Read the relevant provided guidelines BEFORE evaluating the changed code.
2. Apply every guideline relevant to the changed files, dependencies and
   architecture.
3. CITATION (mandatory): every guideline-derived finding must cite the exact
   guideline file and section/heading it comes from.
4. NEVER invent standards: enforce only rules actually present in the
   provided guidelines. Do not import outside standards.
5. A clear violation is a finding even when it has no runtime impact (naming,
   folder structure, layering, architecture, conventions). Do not downgrade it
   to a style nit or an uncertain finding solely because it is not a bug.
6. If no provided guideline applies to an aspect of the change, report nothing
   for that aspect. Do not fall back to general code-review taste.
7. If two provided guidelines conflict, prefer the more specific rule for the
   changed path and state the conflict in the finding.
8. To read a full guideline file, use the "workspace copy" path shown in its
   header. The "## handbook file" path is for citations only.
`.trim();

/**
 * Later-stage reference line. The selected guidelines are re-provided after
 * this line because investigation/reporting run in separate processes.
 */
export const HANDBOOK_REFERENCE_INSTRUCTIONS = `
GUIDELINE MODE (continued): the engineering guidelines provided in the
analysis stage remain the AUTHORITATIVE STANDARD. Apply them, cite the exact
guideline file and section heading for every guideline-derived finding,
enforce only rules present there, treat clear violations as findings even when
they have no runtime impact, and report nothing where no guideline applies.
To read a full guideline file, use the "workspace copy" path shown in its
header; the "## handbook file" path is for citations only.`.trim();
