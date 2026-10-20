"""
HTML reports for environment checks, prerequisites and deployments.

Each renderer takes a finished job (kind, status, request, result, log lines)
and returns one self-contained HTML page (inline CSS, no scripts), so the UI
can show it in an iframe (srcdoc) or offer it as a download.
"""

import html
import re
from datetime import datetime, timezone


def esc(value) -> str:
    return html.escape("" if value is None else str(value))


def as_list(value) -> list:
    """PowerShell JSON can hold a one-item list as a bare object."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def text_list(value) -> str:
    return ", ".join(str(item) for item in as_list(value) if item not in (None, ""))


GOOD = {
    "PASS", "READY", "ELIGIBLE", "PATCHED", "INSTALLED", "SUCCEEDED", "AVAILABLE",
    "ALREADY_COMPLIANT", "OK", "TRUE", "COMPLIANT", "INSTALLED_PENDING_RESTART_DONE",
}
WARN = {
    "WARN", "WARNING", "PENDING_RESTART", "NOT VERIFIED", "UNVERIFIED", "COMPLETED_WITH_ISSUES",
    "REQUEST TIMEOUT", "INSTALLED_PENDING_RESTART", "INSTALLING", "PENDING", "QUEUED", "RUNNING",
    "NOT_FOUND", "UNKNOWN",
}
BAD = {
    "FAIL", "FAILED", "NOT READY", "NOT ELIGIBLE", "NOT_PATCHED", "MISSING", "OUTCOME_UNKNOWN",
    "ERROR", "FALSE",
}


def status_class(value) -> str:
    text = str(value or "").strip().upper()
    if text in GOOD or text.startswith("OK"):
        return "ok"
    if text in BAD or text.startswith("FAILED"):
        return "bad"
    if text in WARN:
        return "warn"
    return "info"


def badge(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, bool):
        value = "Yes" if value else "No"
    return f'<span class="badge {status_class(value)}">{esc(value)}</span>'


def table(headers, rows, empty="Nothing to show.") -> str:
    """rows: lists of cell HTML (already escaped)."""
    if not rows:
        return f'<p class="muted">{esc(empty)}</p>'
    head = "".join(f"<th>{esc(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
    return f'<div class="table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def generic_table(items, empty="Nothing to show.", badge_columns=()) -> str:
    """Table from a list of dicts, columns in first-seen order."""
    items = [item for item in as_list(items) if isinstance(item, dict)]
    columns = []
    for item in items:
        for key in item:
            if key not in columns:
                columns.append(key)
    rows = []
    for item in items:
        row = []
        for key in columns:
            value = item.get(key)
            if isinstance(value, (list, dict)):
                value = text_list(value) if isinstance(value, list) else ", ".join(f"{k}={v}" for k, v in value.items())
            row.append(badge(value) if key in badge_columns else esc(value))
        rows.append(row)
    return table(columns, rows, empty)


def key_values(pairs) -> str:
    cells = "".join(
        f'<div class="kv"><div class="k">{esc(k)}</div><div class="v">{v if raw else esc(v)}</div></div>'
        for k, v, raw in pairs if v not in (None, "", [])
    )
    return f'<div class="kv-grid">{cells}</div>'


def cards(items) -> str:
    """items: (label, value, css class)."""
    return '<div class="cards">' + "".join(
        f'<div class="card {cls}"><div class="num">{esc(value)}</div><div class="lbl">{esc(label)}</div></div>'
        for label, value, cls in items
    ) + "</div>"


def section(title, body, note=None) -> str:
    note_html = f'<p class="muted">{esc(note)}</p>' if note else ""
    return f"<section><h2>{esc(title)}</h2>{note_html}{body}</section>"


CSS = """
:root { --bg:#f5f7fa; --panel:#ffffff; --text:#1d2733; --muted:#5f6b7a; --line:#dde3ea;
  --ok:#137333; --ok-bg:#e6f4ea; --warn:#8a5a00; --warn-bg:#fef3d6; --bad:#b3261e; --bad-bg:#fce8e6;
  --info:#1a4f8b; --info-bg:#e8f0fe; --accent:#0b5cad; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; }
header { background:linear-gradient(120deg,#0b3d75,#0b5cad); color:#fff; padding:28px 32px 22px; }
header h1 { margin:0 0 4px; font-size:24px; font-weight:600; }
header .sub { opacity:.9; }
header .status { margin-top:12px; }
header .badge { font-size:13px; padding:4px 12px; }
main { max-width:1280px; margin:0 auto; padding:24px 32px 40px; }
section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin:0 0 18px; }
h2 { margin:0 0 12px; font-size:17px; font-weight:600; color:#0b3d75; }
h3 { margin:16px 0 8px; font-size:14px; font-weight:600; }
.muted { color:var(--muted); margin:4px 0 10px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:0 0 18px; }
.card { background:var(--panel); border:1px solid var(--line); border-left:5px solid var(--info); border-radius:10px; padding:12px 14px; }
.card.ok { border-left-color:var(--ok); } .card.warn { border-left-color:#e0a100; } .card.bad { border-left-color:var(--bad); }
.card .num { font-size:24px; font-weight:600; } .card .lbl { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.kv-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:8px 20px; }
.kv .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.kv .v { font-weight:500; word-break:break-word; }
.table-wrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; background:#eef2f7; color:#33404f; font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; word-break:break-word; }
tr:hover td { background:#fafbfd; }
.badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; }
.badge.ok { background:var(--ok-bg); color:var(--ok); } .badge.warn { background:var(--warn-bg); color:var(--warn); }
.badge.bad { background:var(--bad-bg); color:var(--bad); } .badge.info { background:var(--info-bg); color:var(--info); }
.timeline { list-style:none; margin:0; padding:0; }
.timeline li { padding:6px 0 6px 18px; border-left:2px solid var(--line); position:relative; }
.timeline li::before { content:""; position:absolute; left:-6px; top:12px; width:10px; height:10px; border-radius:50%; background:var(--accent); }
.timeline .t { color:var(--muted); font-size:12px; margin-right:8px; font-family:Consolas, monospace; }
pre { background:#0f1720; color:#d8e1ea; padding:12px; border-radius:8px; overflow:auto; font-size:12px; max-height:420px; }
.alert { border-radius:8px; padding:10px 14px; margin:0 0 12px; }
.alert.bad { background:var(--bad-bg); color:var(--bad); } .alert.warn { background:var(--warn-bg); color:var(--warn); }
.alert.ok { background:var(--ok-bg); color:var(--ok); }
footer { color:var(--muted); font-size:12px; text-align:center; padding:0 0 24px; }
@media (max-width:700px) { header, main { padding-left:16px; padding-right:16px; } }
@media print { body { background:#fff; } section, .card { break-inside:avoid; } header { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
"""


def page(title, subtitle, status, body) -> str:
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    status_html = f'<div class="status">{badge(status)}</div>' if status else ""
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{esc(title)}</title><style>{CSS}</style></head><body>"
        f"<header><h1>{esc(title)}</h1><div class=\"sub\">{esc(subtitle)}</div>{status_html}</header>"
        f"<main>{body}</main>"
        f"<footer>SCCM Patching Automation &middot; generated {generated}</footer></body></html>"
    )


def job_meta(job: dict) -> list:
    return [
        ("Job ID", job.get("job_id"), False),
        ("Requested by", job.get("requested_by") or "not given", False),
        ("Created", job.get("created_at"), False),
        ("Started", job.get("started_at"), False),
        ("Finished", job.get("finished_at"), False),
        ("Duration", duration_text((job.get("result") or {}).get("duration_seconds")), False),
    ]


def duration_text(seconds) -> str:
    if seconds in (None, ""):
        return ""
    seconds = int(float(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}h {minutes:02d}m {secs:02d}s" if hours else f"{minutes}m {secs:02d}s"


def errors_block(result: dict) -> str:
    errors = [str(e) for e in as_list(result.get("errors")) if e]
    warnings = [str(w) for w in as_list(result.get("warnings")) if w]
    parts = "".join(f'<div class="alert bad">{esc(e)}</div>' for e in errors)
    parts += "".join(f'<div class="alert warn">{esc(w)}</div>' for w in warnings)
    return parts


# ------------------------------------------------------------
# Environment check
# ------------------------------------------------------------

def render_environment(job: dict, logs: list) -> str:
    result = job.get("result") or {}
    checks = as_list(result.get("checks"))
    bad = sum(1 for c in checks if status_class(c.get("Status")) == "bad")
    warn = sum(1 for c in checks if status_class(c.get("Status")) in ("warn", "info"))
    body = errors_block(result)
    body += cards([
        ("Checks", len(checks), "info"),
        ("Passed / available", len(checks) - bad - warn, "ok"),
        ("Warnings / not verified", warn, "warn" if warn else "ok"),
        ("Failed", bad, "bad" if bad else "ok"),
    ])
    body += section("Run", key_values(job_meta(job) + [
        ("Jumphost", result.get("host"), False),
        ("Run as", result.get("run_as"), False),
        ("Script", result.get("script"), False),
    ]))
    body += section("Checks", table(
        ["Check", "Status", "Detail"],
        [[esc(c.get("Check")), badge(c.get("Status")), esc(c.get("Detail"))] for c in checks],
        "The environment check returned no structured results; see the output below.",
    ))
    if result.get("output"):
        body += section("Script output", f"<pre>{esc(result.get('output'))}</pre>")
    status = job.get("status")
    return page("Environment Check", "Jumphost readiness for SCCM patching", status, body)


# ------------------------------------------------------------
# Prerequisites
# ------------------------------------------------------------

def render_prerequisites(job: dict, logs: list) -> str:
    result = job.get("result") or {}
    servers = [s for s in as_list(result.get("servers")) if isinstance(s, dict)]
    checks = [c for c in as_list(result.get("checks")) if isinstance(c, dict)]
    ready = sum(1 for s in servers if str(s.get("Overall")).upper() == "READY")
    eligible = sum(1 for s in servers if str(s.get("Eligibility")).upper() == "ELIGIBLE")
    failed_checks = sum(1 for c in checks if status_class(c.get("Status")) == "bad")
    warn_checks = sum(1 for c in checks if status_class(c.get("Status")) == "warn")

    body = errors_block(result)
    if servers:
        if ready == len(servers):
            body += '<div class="alert ok">All servers are READY for patching.</div>'
        else:
            body += f'<div class="alert warn">{len(servers) - ready} of {len(servers)} servers are NOT READY. Review the failed checks before selecting them.</div>'
    body += cards([
        ("Servers checked", len(servers), "info"),
        ("Ready", ready, "ok" if ready else "warn"),
        ("Not ready", len(servers) - ready, "bad" if len(servers) - ready else "ok"),
        ("Eligible (SOP step 6)", eligible, "ok" if eligible == len(servers) else "warn"),
        ("Failed checks", failed_checks, "bad" if failed_checks else "ok"),
        ("Warnings", warn_checks, "warn" if warn_checks else "ok"),
    ])
    body += section("Run", key_values(job_meta(job) + [
        ("Jumphost", result.get("host"), False),
        ("Run as", result.get("run_as"), False),
        ("Report folder (jumphost)", result.get("report_folder_name"), False),
    ]))
    body += section("Server summary", table(
        ["Server", "Eligibility", "Overall", "Failed checks", "Warnings"],
        [[f"<strong>{esc(s.get('Server'))}</strong>", badge(s.get("Eligibility")), badge(s.get("Overall")),
          esc(s.get("Failed")), esc(s.get("Warnings"))] for s in servers],
        "No server results.",
    ))

    groups = {}
    for c in checks:
        groups.setdefault(str(c.get("Target") or "General"), []).append(c)
    detail = ""
    for target, items in groups.items():
        detail += f"<h3>{esc(target)}</h3>" + table(
            ["Check", "Status", "Detail", "Time (UTC)"],
            [[esc(c.get("Check")), badge(c.get("Status")), esc(c.get("Detail")), esc(c.get("TimestampUtc"))] for c in items],
        )
    body += section("Checks per target", detail or '<p class="muted">No check details.</p>')
    if not checks and result.get("output"):
        body += section("Script output", f"<pre>{esc(result.get('output'))}</pre>")
    return page("Prerequisite Checks", "Server readiness per the T1 Server Patch Deployment SOP", job.get("status"), body)


# ------------------------------------------------------------
# Deployment
# ------------------------------------------------------------

STEP_LINE = re.compile(r"^\s*(\d+)\.\s+[A-Z]")


def render_deployment(job: dict, logs: list) -> str:
    result = job.get("result") or {}
    request = job.get("request") or {}
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    servers = [s for s in as_list(result.get("servers") or summary.get("Results")) if isinstance(s, dict)]
    validation = [v for v in as_list(result.get("validation")) if isinstance(v, dict)]
    deployment = result.get("deployment") or summary.get("Deployment") or {}
    window = result.get("maintenance_window") or summary.get("MaintenanceWindow") or {}

    patched = sum(1 for s in servers if str(s.get("Verdict")).upper() == "PATCHED")
    compliant = sum(1 for s in servers if s.get("AlreadyCompliant") in (True, "True", "true"))
    restarted = sum(1 for s in servers if s.get("Restarted") in (True, "True", "true"))
    kb_installed = sum(1 for v in validation if str(v.get("Result")).upper() == "INSTALLED")
    kb_missing = sum(1 for v in validation if str(v.get("Result")).upper() == "MISSING")

    status = job.get("status")
    body = ""
    if status == "SUCCEEDED":
        body += '<div class="alert ok">Every server is PATCHED.</div>'
    elif status == "COMPLETED_WITH_ISSUES":
        body += '<div class="alert warn">The deployment ran, but not every server is PATCHED. See the server results and KB validation below.</div>'
    elif status == "OUTCOME_UNKNOWN":
        body += '<div class="alert bad">The run was cut off after the deployment may have been created. Resume it or check SCCM.</div>'
    body += errors_block(result)
    if result.get("next_step"):
        body += f'<div class="alert warn">Next step: {esc(result.get("next_step"))}</div>'

    body += cards([
        ("Servers", len(servers), "info"),
        ("Patched", patched, "ok" if servers and patched == len(servers) else "warn"),
        ("Not patched", len(servers) - patched, "bad" if len(servers) - patched else "ok"),
        ("Already compliant", compliant, "info"),
        ("Restarted", restarted, "info"),
        ("KBs installed", kb_installed, "ok"),
        ("KBs missing", kb_missing, "bad" if kb_missing else "ok"),
    ])

    body += section("Overview", key_values([
        ("Deployment", result.get("deployment_name") or summary.get("DeploymentName") or request.get("DeploymentName"), False),
        ("Software update group", result.get("sug") or summary.get("SUG") or request.get("SugName"), False),
        ("Collection", result.get("collection") or summary.get("Collection") or request.get("CollectionName"), False),
        ("Collection ID", summary.get("CollectionId") or request.get("CollectionId"), False),
        ("Collection created", "Yes" if result.get("collection_created") or summary.get("CollectionCreated") else None, False),
        ("Selected servers", text_list(request.get("Servers")), False),
        ("Change ticket", summary.get("ChangeTicket") or request.get("ChangeTicket"), False),
        ("Approver", summary.get("Approver") or request.get("Approver"), False),
        ("Approval reference", summary.get("ApprovalReference") or request.get("ApprovalReference"), False),
        ("Restart mode", request.get("RestartMode"), False),
        ("Jumphost", result.get("host"), False),
        ("Run as", result.get("run_as"), False),
        ("Report folder (jumphost)", result.get("report_folder_name"), False),
    ] + job_meta(job)))

    window_pairs = [
        ("Window", window.get("Name"), False),
        ("Start (UTC)", window.get("StartUtc") or request.get("MaintenanceWindowStartUtc"), False),
        ("End (UTC)", window.get("EndUtc"), False),
        ("Requested deadline (UTC)", request.get("DeadlineUtc") or "As soon as possible", False),
        ("Deployment available", deployment.get("StartTime"), False),
        ("Deployment deadline", deployment.get("EnforcementDeadline"), False),
    ]
    body += section("Maintenance window and schedule", key_values(window_pairs))

    if deployment:
        body += section("Deployment settings (read back from SCCM)", table(
            ["Setting", "Value"],
            [[esc(k), esc(v)] for k, v in deployment.items()],
        ))

    body += section("Server results", table(
        ["Server", "Verdict", "Already compliant", "Install state", "Restarted", "KBs required before", "Missing KBs", "Detail"],
        [[f"<strong>{esc(s.get('Server'))}</strong>", badge(s.get("Verdict")), badge(s.get("AlreadyCompliant")),
          badge(s.get("InstallState")), badge(s.get("Restarted")), esc(text_list(s.get("RequiredKbsBefore"))),
          esc(text_list(s.get("MissingKbs"))), esc(s.get("Detail"))] for s in servers],
        "No server results (the run stopped before validation).",
    ))

    if validation:
        rows = sorted(validation, key=lambda v: (str(v.get("Server")), str(v.get("Result")), str(v.get("KB"))))
        body += section("KB validation per server", table(
            ["Server", "KB", "Title", "Result", "SCCM status", "Evidence", "Note"],
            [[esc(v.get("Server")), f"<strong>{esc(v.get('KB'))}</strong>", esc(v.get("Title")), badge(v.get("Result")),
              esc(v.get("SccmStatus")), esc(v.get("Evidence")), esc(v.get("Note"))] for v in rows],
        ))

    baseline = summary.get("Baseline")
    if baseline:
        body += section("Baseline before deployment", generic_table(baseline), "Updates each server needed when the run started.")
    content = summary.get("ContentPackages")
    if content:
        body += section("Content distribution", generic_table(content) if isinstance(content, list) else f"<p>{esc(content)}</p>")

    steps = []
    for entry in logs or []:
        line = str(entry.get("line", ""))
        if STEP_LINE.match(line) or line.startswith("Job ") or line.startswith("RESUMING"):
            steps.append(f'<li><span class="t">{esc(entry.get("time"))}</span>{esc(line.strip())}</li>')
    if steps:
        body += section("Timeline", f'<ul class="timeline">{"".join(steps)}</ul>')

    issues = [entry for entry in logs or [] if re.match(r"^\s*(WARNING|ERROR)\b", str(entry.get("line", "")))]
    if issues:
        body += section(
            f"Warnings and errors from the log ({len(issues)})",
            "<pre>" + esc("\n".join(f"{e.get('time')}  {e.get('line')}" for e in issues[-200:])) + "</pre>",
        )

    name = result.get("deployment_name") or summary.get("DeploymentName") or request.get("DeploymentName") or "Deployment"
    return page(f"Patch Deployment Report: {name}", "Deployment, installation, restart and KB validation", status, body)


def report_type(kind: str, result: dict) -> str:
    if kind == "report_import":
        return str((result or {}).get("report_type") or "other")
    if kind in ("deployment", "deployment_resume"):
        return "deployment"
    return kind


def render_report(job: dict, logs: list) -> str:
    kind = report_type(job.get("kind"), job.get("result") or {})
    if kind == "environment":
        return render_environment(job, logs)
    if kind == "prerequisites":
        return render_prerequisites(job, logs)
    if kind == "deployment":
        return render_deployment(job, logs)
    return page("Report", "No report layout for this job", job.get("status"),
                section("Result", f"<pre>{esc(job.get('result'))}</pre>"))


def report_headline(kind: str, result: dict) -> str:
    """One line for report lists."""
    result = result or {}
    kind = report_type(kind, result)
    if kind == "prerequisites":
        servers = [s for s in as_list(result.get("servers")) if isinstance(s, dict)]
        ready = sum(1 for s in servers if str(s.get("Overall")).upper() == "READY")
        return f"{ready} of {len(servers)} servers READY" if servers else "No server results"
    if kind == "environment":
        checks = as_list(result.get("checks"))
        bad = sum(1 for c in checks if isinstance(c, dict) and status_class(c.get("Status")) == "bad")
        return f"{len(checks)} checks, {bad} failed"
    if kind == "deployment":
        summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
        servers = [s for s in as_list(result.get("servers") or summary.get("Results")) if isinstance(s, dict)]
        patched = sum(1 for s in servers if str(s.get("Verdict")).upper() == "PATCHED")
        if servers:
            return f"{patched} of {len(servers)} servers PATCHED"
        errors = as_list(result.get("errors"))
        return str(errors[0])[:160] if errors else "No server results"
    return ""
