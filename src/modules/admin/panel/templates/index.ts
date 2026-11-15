/**
 * Server-rendered admin panel templates (ticket 14).
 *
 * Templates are EJS sources kept as strings so the TypeScript build stays a
 * plain `tsc` compile (no asset copying) and runtime has no filesystem
 * dependency. All dynamic values are escaped with `<%= %>` unless the value
 * is pre-escaped HTML produced by the panel renderer itself.
 *
 * No secrets are ever interpolated: values rendered into forms come from
 * redactConfiguration output only.
 */

export const PANEL_CSS = `
:root { --ink:#1f2430; --muted:#5b6472; --line:#d8dde5; --accent:#1f6feb; --danger:#b42318; --ok:#067647; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: #f6f8fa; }
header { background: #ffffff; border-bottom: 1px solid var(--line); padding: 0.75rem 1.5rem; }
header h1 { font-size: 1.05rem; margin: 0 0 0.35rem; }
nav { display: flex; flex-wrap: wrap; gap: 0.35rem; }
nav a { display: inline-block; padding: 0.3rem 0.7rem; border-radius: 6px; color: var(--ink); text-decoration: none; font-size: 0.9rem; }
nav a:hover { background: #eef1f5; }
nav a.active { background: var(--accent); color: #fff; }
main { max-width: 60rem; margin: 1.5rem auto; padding: 0 1.5rem; }
h2 { font-size: 1.15rem; }
.version { color: var(--muted); font-size: 0.85rem; margin: 0.25rem 0 1rem; }
code { background: #eef1f5; padding: 0.05rem 0.35rem; border-radius: 4px; font-size: 0.85em; }
form.panel-form fieldset { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 1rem 1.25rem; margin: 0 0 1rem; }
.field { margin: 0 0 0.9rem; }
.field label { display: block; font-weight: 600; font-size: 0.88rem; margin-bottom: 0.25rem; }
.field input[type="text"], .field input[type="number"], .field textarea {
  width: 100%; max-width: 34rem; padding: 0.4rem 0.55rem; border: 1px solid var(--line);
  border-radius: 6px; font: inherit; background: #fff; color: var(--ink);
}
.field input[readonly], .field textarea[readonly] { background: #eef1f5; color: var(--muted); }
.field.has-error input, .field.has-error textarea { border-color: var(--danger); }
.help { color: var(--muted); font-size: 0.8rem; margin: 0.2rem 0 0; }
.field-error { color: var(--danger); font-size: 0.82rem; margin: 0.2rem 0 0; font-weight: 600; }
.checkbox-field label { display: inline-flex; align-items: center; gap: 0.45rem; font-weight: 600; font-size: 0.88rem; }
button { font: inherit; padding: 0.45rem 1rem; border-radius: 6px; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; cursor: pointer; margin-right: 0.5rem; }
button.secondary { background: #fff; color: var(--accent); }
button:hover { opacity: 0.92; }
.notice { background: #e7f6ee; color: var(--ok); border: 1px solid #b5e2c8; border-radius: 6px; padding: 0.55rem 0.8rem; }
.error { background: #fdecea; color: var(--danger); border: 1px solid #f3c1ba; border-radius: 6px; padding: 0.55rem 0.8rem; }
.warning { color: #955f00; }
.notice-inline { color: var(--ok); font-weight: 600; }
.actions form { display: inline-block; margin-right: 0.75rem; }
table.data { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 8px; }
table.data th, table.data td { text-align: left; padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--line); font-size: 0.85rem; vertical-align: top; }
table.data th { background: #eef1f5; }
.pagination { margin-top: 0.9rem; font-size: 0.9rem; }
.pagination a, .pagination span { margin-right: 0.6rem; }
.pagination .disabled { color: var(--muted); }
`;

export const LAYOUT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><%= title %> · AI PR Reviewer Admin</title>
<style><%- css %></style>
</head>
<body>
<header>
<h1>AI PR Reviewer — Admin Panel</h1>
<% if (user) { %><p class="session">Signed in as <strong><%= user %></strong></p><% } %>
<nav>
<% for (const item of nav) { %><a href="<%= item.href %>"<%- item.active ? ' class="active"' : '' %>><%= item.label %></a><% } %>
<a href="/admin/audit"<%- active === 'audit' ? ' class="active"' : '' %>>Audit History</a>
</nav>
</header>
<main>
<% if (version) { %>
<p class="version">Configuration version: schema <strong>v<%= version.schemaVersion %></strong> · <code><%= version.hash %></code><% if (version.fromLastKnownGood) { %> · <span class="warning">served from last-known-good snapshot</span><% } %></p>
<% } %>
<%- body %>
</main>
</body>
</html>`;

export const OVERVIEW_TEMPLATE = `<h2>Overview</h2>
<% if (notice) { %><p class="notice"><%= notice %></p><% } %>
<% if (error) { %><p class="error"><%= error %></p><% } %>
<p>Manage the central review configuration section by section. Changes are validated
against the configuration schema before anything is written; the previous
configuration is kept as a last-known-good snapshot for rollback.</p>
<div class="actions">
<form method="post" action="/admin/config/reload">
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
<button type="submit">Reload configuration</button>
</form>
<form method="post" action="/admin/config/rollback">
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
<button type="submit" class="secondary">Rollback to last-known-good</button>
</form>
</div>
<h3>Sections</h3>
<ul>
<% for (const item of nav) { if (item.href !== '/admin') { %>
<li><a href="<%= item.href %>"><%= item.label %></a></li>
<% } } %>
<li><a href="/admin/audit">Audit History</a> — configuration changes and admin events, newest first</li>
</ul>`;

export const SECTION_TEMPLATE = `<h2><%= sectionLabel %></h2>
<% if (notice) { %><p class="notice"><%= notice %></p><% } %>
<% if (error) { %><p class="error"><%= error %></p><% } %>
<% if (validationPassed) { %><p class="notice-inline">Validation passed — nothing was saved.</p><% } %>
<form method="post" action="/admin/<%= section %>" class="panel-form">
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
<fieldset>
<% for (const field of fields) { %>
<div class="field<%- field.error ? ' has-error' : '' %><%- field.type === 'boolean' ? ' checkbox-field' : '' %>">
<% if (field.type === 'boolean') { %>
<%- field.input %>
<% } else { %>
<label for="<%= field.id %>"><%= field.label %></label>
<%- field.input %>
<% } %>
<% if (field.help) { %><p class="help"><%= field.help %></p><% } %>
<% if (field.error) { %><p class="field-error"><%= field.error %></p><% } %>
</div>
<% } %>
</fieldset>
<button type="submit" name="action" value="save">Save</button>
<button type="submit" name="action" value="validate" class="secondary">Validate (no save)</button>
</form>`;

export const INTERSTITIAL_TEMPLATE = `<h2>Confirm sensitive changes — <%= sectionLabel %></h2>
<p class="error">You are about to change execution-policy settings that affect sandboxing
and command execution. Review the diff below, then confirm — until you confirm, the
configuration stays read-only and nothing is persisted.</p>
<table class="data">
<tr><th>Field</th><th>Current value</th><th>New value</th></tr>
<% for (const change of changes) { %>
<tr><td><code><%= change.path %></code></td><td><code><%= change.oldValue %></code></td><td><code><%= change.newValue %></code></td></tr>
<% } %>
</table>
<form method="post" action="/admin/<%= section %>">
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
<input type="hidden" name="action" value="save">
<input type="hidden" name="confirm" value="confirmed">
<input type="hidden" name="candidate" value="<%= candidateJson %>">
<p>
<button type="submit">Confirm and save</button>
<a href="/admin/<%= section %>">Cancel (discard changes)</a>
</p>
</form>`;

export const AUDIT_TEMPLATE = `<h2>Audit History</h2>
<% if (rows.length === 0) { %><p>No audit events recorded yet.</p><% } else { %>
<table class="data">
<tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Details</th></tr>
<% for (const row of rows) { %>
<tr>
<td><%= row.createdAt %></td>
<td><%= row.actor %></td>
<td><code><%= row.action %></code></td>
<td><%= row.resource %></td>
<td><code><%= row.metadata %></code></td>
</tr>
<% } %>
</table>
<p class="pagination">
<% if (page > 1) { %><a href="/admin/audit?page=<%= page - 1 %>">&larr; Newer</a><% } else { %><span class="disabled">&larr; Newer</span><% } %>
<span>Page <%= page %> of <%= totalPages %></span>
<% if (page < totalPages) { %><a href="/admin/audit?page=<%= page + 1 %>">Older &rarr;</a><% } else { %><span class="disabled">Older &rarr;</span><% } %>
</p>
<% } %>`;

export const MESSAGE_TEMPLATE = `<h2><%= title %></h2>
<p class="<%= tone %>"><%= message %></p>
<p><a href="/admin">Back to the admin panel</a></p>`;
