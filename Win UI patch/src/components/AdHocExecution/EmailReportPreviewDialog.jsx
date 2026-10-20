import React, { useState } from 'react';
import './EmailReportPreviewDialog.css';

export default function EmailReportPreviewDialog({ isOpen, onClose, data }) {
  const [testEmail, setTestEmail] = useState('ops-monitoring@cdk.com');
  const [isSending, setIsSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!isOpen || !data) return null;

  const { report, applications, alerts } = data;

  const handleSendTestEmail = (e) => {
    e.preventDefault();
    if (!testEmail) return;

    setIsSending(true);
    setSendSuccess(false);

    setTimeout(() => {
      setIsSending(false);
      setSendSuccess(true);
      setTimeout(() => setSendSuccess(false), 4000);
    }, 1200);
  };

  const handleCopyReport = () => {
    const text = `NOVA HOURLY VALIDATION REPORT - ${report.currentCycle}\n` +
      `Report ID: ${report.reportId}\n` +
      `Overall Availability: ${report.overallAvailability}%\n` +
      `Checks Passed: ${report.passedChecks}/${report.totalChecks}\n\n` +
      `APPLICATIONS:\n` +
      applications.map(a => `- ${a.name}: ${a.status} (Playwright: ${a.playwright.status}, Latency: ${a.newRelic.latency}, Apdex: ${a.newRelic.apmStatus})`).join('\n') +
      `\n\nACTIVE INCIDENTS:\n` +
      alerts.map(al => `[${al.severity}] ${al.application} (${al.channel}): ${al.summary}`).join('\n');

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="erp-modal-backdrop" onClick={onClose}>
      <div className="erp-modal-container" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="erp-modal-header">
          <div className="erp-header-title">
            <div className="erp-badge">
              <i className="fa-regular fa-envelope"></i>
              <span>Email Report Distribution Preview</span>
            </div>
            <h2>{report.currentCycle} - Observability Dispatch</h2>
            <p className="erp-header-sub">
              Automated executive and operational email dispatched to on-call engineering, leadership, and SRE distribution lists.
            </p>
          </div>
          <button className="erp-close-btn" onClick={onClose} aria-label="Close modal">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        {/* Email Meta Bar */}
        <div className="erp-meta-bar">
          <div className="erp-meta-row">
            <span className="erp-meta-label">Subject:</span>
            <span className="erp-meta-value">
              [OBSERVABILITY HOURLY] {report.currentCycle} - Health: {report.overallAvailability}% ({report.failedChecks > 0 ? '1 ATTENTION' : 'ALL CLEAR'})
            </span>
          </div>
          <div className="erp-meta-row">
            <span className="erp-meta-label">Recipients:</span>
            <span className="erp-meta-tags">
              {report.distributionList.map((email, idx) => (
                <span key={idx} className="erp-email-tag">
                  <i className="fa-regular fa-envelope"></i> {email}
                </span>
              ))}
            </span>
          </div>
        </div>

        {/* Formatted Email Body View */}
        <div className="erp-email-canvas">
          <div className="erp-email-card">
            {/* CDK Brand Header */}
            <div className="erp-email-brand">
              <div className="erp-brand-logo">
                <span className="erp-brand-nova">NOVA</span>
                <span className="erp-brand-tag">Validation Engine</span>
              </div>
              <div className="erp-email-timestamp">
                {new Date(report.cycleTime).toUTCString()}
              </div>
            </div>

            {/* KPI Banner in Email */}
            <div className="erp-kpi-grid">
              <div className="erp-kpi-item">
                <span className="erp-kpi-num">{report.overallAvailability}%</span>
                <span className="erp-kpi-title">Availability</span>
              </div>
              <div className="erp-kpi-item">
                <span className="erp-kpi-num">{report.passedChecks}/{report.totalChecks}</span>
                <span className="erp-kpi-title">Passed Checks</span>
              </div>
              <div className="erp-kpi-item">
                <span className={`erp-kpi-num ${report.failedChecks > 0 ? 'alert' : ''}`}>
                  {report.failedChecks}
                </span>
                <span className="erp-kpi-title">Failed Checks</span>
              </div>
              <div className="erp-kpi-item">
                <span className="erp-kpi-num">{report.nextRunInMinutes}m</span>
                <span className="erp-kpi-title">Next Cycle</span>
              </div>
            </div>

            {/* Application Matrix Table in Email */}
            <h3 className="erp-section-heading">Application Health & Observability Matrix</h3>
            <div className="erp-table-responsive">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Application</th>
                    <th>Status</th>
                    <th>Playwright UI</th>
                    <th>New Relic APM</th>
                    <th>Cribl Telemetry</th>
                    <th>DevOps</th>
                    <th>SSL Cert</th>
                    <th>Teams Channel</th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map(app => (
                    <tr key={app.id} className={app.status === 'ATTENTION' ? 'erp-row-attention' : ''}>
                      <td>
                        <strong>{app.name}</strong>
                        <div className="erp-sub-text">{app.businessArea}</div>
                      </td>
                      <td>
                        <span className={`erp-chip ${app.status === 'HEALTHY' ? 'healthy' : 'attention'}`}>
                          {app.status}
                        </span>
                      </td>
                      <td>
                        <span className={`erp-chip ${app.playwright.status === 'PASS' ? 'healthy' : 'fail'}`}>
                          {app.playwright.status} ({app.playwright.testsPassed}/{app.playwright.testsRun})
                        </span>
                        <div className="erp-sub-text">{app.playwright.duration}</div>
                      </td>
                      <td>
                        <div>{app.newRelic.synthetics} uptime</div>
                        <div className="erp-sub-text">{app.newRelic.latency} • {app.newRelic.errorRate} err</div>
                      </td>
                      <td>
                        <div>{app.cribl.status}</div>
                        <div className="erp-sub-text">{app.cribl.rate}</div>
                      </td>
                      <td>
                        <div>{app.devOps.githubStatus}</div>
                        <div className="erp-sub-text">{app.devOps.harnessPipeline}</div>
                      </td>
                      <td>
                        <span className="erp-chip valid">VALID</span>
                        <div className="erp-sub-text">{app.ssl.daysRemaining}d left</div>
                      </td>
                      <td>
                        <span className="erp-teams-tag">{app.teamsChannel}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Active Alerts in Email */}
            {alerts && alerts.length > 0 && (
              <div className="erp-alerts-section">
                <h3 className="erp-section-heading">
                  <i className="fa-solid fa-triangle-exclamation"></i> Active Incident Dispatches
                </h3>
                <div className="erp-alerts-list">
                  {alerts.map(al => (
                    <div key={al.id} className={`erp-alert-item ${al.severity.toLowerCase()}`}>
                      <div className="erp-alert-header">
                        <span className="erp-alert-badge">{al.severity}</span>
                        <strong className="erp-alert-app">{al.application}</strong>
                        <span className="erp-alert-channel">{al.channel}</span>
                        <span className="erp-alert-time">{new Date(al.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p className="erp-alert-summary">{al.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Test Email Dispatch & Actions Footer */}
        <div className="erp-modal-footer">
          <form className="erp-test-email-form" onSubmit={handleSendTestEmail}>
            <label htmlFor="test-email-input" className="erp-test-label">
              <i className="fa-solid fa-paper-plane"></i> Send Test Dispatch:
            </label>
            <input
              id="test-email-input"
              type="email"
              className="erp-test-input"
              placeholder="Enter email..."
              value={testEmail}
              onChange={e => setTestEmail(e.target.value)}
              required
            />
            <button
              type="submit"
              className="erp-btn erp-btn-action"
              disabled={isSending}
            >
              {isSending ? (
                <>
                  <i className="fa-solid fa-spinner fa-spin"></i> Sending...
                </>
              ) : (
                'Send Test Email'
              )}
            </button>
            {sendSuccess && (
              <span className="erp-send-toast">
                <i className="fa-solid fa-check"></i> Dispatched to {testEmail}!
              </span>
            )}
          </form>

          <div className="erp-footer-actions">
            <button
              type="button"
              className="erp-btn erp-btn-secondary"
              onClick={handleCopyReport}
            >
              <i className={`fa-solid ${copied ? 'fa-check' : 'fa-copy'}`}></i>
              <span>{copied ? 'Report Copied!' : 'Copy Text'}</span>
            </button>
            <button
              type="button"
              className="erp-btn erp-btn-secondary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
