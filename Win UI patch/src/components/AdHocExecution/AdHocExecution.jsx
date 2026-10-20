import React, { useState, useEffect, useMemo } from 'react';
import { initialDashboardPayload } from '../../data/validationData';
import EmailReportPreviewDialog from './EmailReportPreviewDialog';
import RunValidationDialog from './RunValidationDialog';
import CustomScriptRunner from './CustomScriptRunner';
import './AdHocExecution.css';

export default function AdHocExecution() {
  const [activeTab, setActiveTab] = useState('script-runner');
  const [data, setData] = useState(initialDashboardPayload);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedAppId, setExpandedAppId] = useState(null);
  const [isEmailPreviewOpen, setIsEmailPreviewOpen] = useState(false);
  const [isRunValidationOpen, setIsRunValidationOpen] = useState(false);
  const [countdownMinutes, setCountdownMinutes] = useState(18);
  const [teamsModalAlert, setTeamsModalAlert] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const [incidentDismissed, setIncidentDismissed] = useState(false);

  // Simulated live countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdownMinutes(prev => (prev > 1 ? prev - 1 : 60));
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleValidationComplete = () => {
    // Refresh dashboard stats on run complete
    setData(prev => ({
      ...prev,
      report: {
        ...prev.report,
        reportId: `EVR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${new Date().getHours()}00`,
        currentCycle: `Hourly Batch #${Math.floor(1842 + Math.random() * 10)} (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} UTC)`,
        cycleTime: new Date().toISOString(),
        nextRunInMinutes: 60,
        passedChecks: 28,
        failedChecks: 0,
        overallAvailability: 100.0,
      },
      applications: prev.applications.map(app => {
        if (app.id === 'lead-crm') {
          return {
            ...app,
            status: 'HEALTHY',
            playwright: {
              ...app.playwright,
              status: 'PASS',
              testsPassed: 7,
              failedTest: null,
            },
            newRelic: {
              ...app.newRelic,
              latency: '198ms',
              apmStatus: 'Healthy (0.97 Apdex)',
              errorRate: '0.01%',
            },
          };
        }
        return app;
      }),
      alerts: [
        {
          id: `alert-${Date.now()}`,
          channel: '#alerts-lead-crm',
          application: 'Lead CRM',
          component: 'Playwright UI & New Relic',
          severity: 'RESOLVED',
          timestamp: new Date().toISOString(),
          summary: 'Ad-hoc batch execution re-tested Credit Application Upload flow. 7/7 checks passed, latency normalized to 198ms.',
          status: 'RESOLVED',
          teamsUrl: 'https://teams.microsoft.com/l/channel/lead-crm-alerts',
        },
        ...prev.alerts,
      ],
    }));
    setIncidentDismissed(true);
    showToast('Batch execution completed! All 4 applications re-validated and reports refreshed.');
  };

  const handleOpenTeams = (channelOrAlert) => {
    if (typeof channelOrAlert === 'string') {
      const alertMatch = data.alerts.find(a => a.channel === channelOrAlert);
      setTeamsModalAlert(alertMatch || {
        channel: channelOrAlert,
        application: 'Monitored Application',
        summary: `Direct routing link to Microsoft Teams workspace channel ${channelOrAlert}.`,
        teamsUrl: 'https://teams.microsoft.com',
      });
    } else {
      setTeamsModalAlert(channelOrAlert);
    }
  };

  const filteredApps = useMemo(() => {
    return data.applications.filter(app => {
      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'ATTENTION' && app.status === 'ATTENTION') ||
        (statusFilter === 'HEALTHY' && app.status === 'HEALTHY');

      const matchesSearch =
        app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        app.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        app.businessArea.toLowerCase().includes(searchTerm.toLowerCase()) ||
        app.teamsChannel.toLowerCase().includes(searchTerm.toLowerCase());

      return matchesStatus && matchesSearch;
    });
  }, [data.applications, statusFilter, searchTerm]);

  // Active incident determination
  const activeIncident = useMemo(() => {
    return data.alerts.find(al => al.severity === 'CRITICAL' && al.status !== 'RESOLVED');
  }, [data.alerts]);

  return (
    <div className="adhoc-root" id="adhoc-execution-view">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="adhoc-toast">
          <i className="fa-solid fa-circle-check"></i>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Container */}
      <div className="adhoc-container">
        {/* Top Header & Quick Actions */}
        <header className="adhoc-header">
          <div className="adhoc-header-main">
            <div className="adhoc-header-badge">
              <span className="adhoc-pulse-dot"></span>
              <span>Hourly Validation Engine</span>
            </div>
            <h1 className="adhoc-title">Ad-Hoc Execution & Observability Console</h1>
            <p className="adhoc-subtitle">
              Comprehensive telemetry, synthetic UI validation, infrastructure health & on-demand batch execution for enterprise core services.
            </p>
          </div>

          <div className="adhoc-header-actions">
            <button
              type="button"
              className="adhoc-btn adhoc-btn-outline"
              onClick={() => setIsEmailPreviewOpen(true)}
              id="btn-preview-hourly-email"
            >
              <i className="fa-regular fa-envelope"></i>
              <span>Preview Hourly Email</span>
            </button>
            <button
              type="button"
              className="adhoc-btn adhoc-btn-primary"
              onClick={() => setIsRunValidationOpen(true)}
              id="btn-run-validations-now"
            >
              <i className="fa-solid fa-play"></i>
              <span>Run Validations Now</span>
            </button>
          </div>
        </header>

        {/* Tab Navigation Switcher */}
        <div className="adhoc-tabs-bar" role="tablist">
          <button
            type="button"
            className={`adhoc-tab-btn ${activeTab === 'script-runner' ? 'active' : ''}`}
            onClick={() => setActiveTab('script-runner')}
            id="tab-script-runner"
          >
            <i className="fa-solid fa-terminal"></i>
            <span>Custom Script & Machine Runner</span>
            <span className="adhoc-tab-pill">TypeScript + Host</span>
          </button>
          <button
            type="button"
            className={`adhoc-tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
            id="tab-dashboard"
          >
            <i className="fa-solid fa-chart-line"></i>
            <span>Hourly Observability & Matrix</span>
            <span className="adhoc-tab-pill">4 Core Apps</span>
          </button>
        </div>

        {activeTab === 'script-runner' ? (
          <CustomScriptRunner />
        ) : (
          <>
            {/* Cadence & Scope Bar */}
            <section className="adhoc-cadence-bar" aria-label="Cadence and scope status">
          <div className="adhoc-cadence-left">
            <div className="adhoc-timer-chip" title="Next scheduled validation run">
              <i className="fa-regular fa-clock"></i>
              <span>Next Run in <strong>{countdownMinutes}m</strong></span>
            </div>
            <div className="adhoc-batch-chip">
              <i className="fa-solid fa-layer-group"></i>
              <span>{data.report.currentCycle}</span>
            </div>
            <div className="adhoc-cadence-pill">
              <i className="fa-solid fa-arrows-spin"></i>
              <span>{data.report.scheduleCadence}</span>
            </div>
          </div>

          <div className="adhoc-scope-badges" aria-label="Monitored components">
            <span className="adhoc-badge" title="Playwright E2E UI Checks">
              <i className="fa-solid fa-vial-virus"></i> Playwright UI
            </span>
            <span className="adhoc-badge" title="New Relic Synthetics & APM Metrics">
              <i className="fa-solid fa-chart-line"></i> New Relic
            </span>
            <span className="adhoc-badge" title="Cribl Log Stream Pipelines">
              <i className="fa-solid fa-bolt-lightning"></i> Cribl
            </span>
            <span className="adhoc-badge" title="GitHub Actions & Harness Continuous Delivery">
              <i className="fa-brands fa-github"></i> GitHub & Harness
            </span>
            <span className="adhoc-badge" title="SSL & Transport Security">
              <i className="fa-solid fa-lock"></i> SSL Certs
            </span>
            <span className="adhoc-badge" title="Microsoft Teams Alert Channels">
              <i className="fa-brands fa-microsoft"></i> MS Teams
            </span>
          </div>
        </section>

        {/* Active Incident Banner (Shown when an alert requires attention) */}
        {activeIncident && !incidentDismissed && (
          <section className="adhoc-incident-banner" aria-live="polite">
            <div className="adhoc-incident-icon">
              <i className="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div className="adhoc-incident-content">
              <div className="adhoc-incident-header">
                <span className="adhoc-incident-tag">ACTION REQUIRED</span>
                <strong>{activeIncident.application} Alert:</strong>
                <span>{activeIncident.summary}</span>
              </div>
              <div className="adhoc-incident-meta">
                <span><i className="fa-solid fa-microchip"></i> {activeIncident.component}</span>
                <span><i className="fa-regular fa-clock"></i> {new Date(activeIncident.timestamp).toLocaleTimeString()} UTC</span>
                <span><i className="fa-brands fa-microsoft"></i> Routed to {activeIncident.channel}</span>
              </div>
            </div>
            <div className="adhoc-incident-actions">
              <button
                type="button"
                className="adhoc-btn adhoc-btn-amber"
                onClick={() => handleOpenTeams(activeIncident)}
              >
                <i className="fa-brands fa-microsoft"></i>
                <span>Open in Teams</span>
              </button>
              <button
                type="button"
                className="adhoc-icon-close-btn"
                onClick={() => setIncidentDismissed(true)}
                title="Dismiss banner"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          </section>
        )}

        {/* 4 Critical Application Health Cards */}
        <section className="adhoc-cards-section">
          <div className="adhoc-section-header">
            <div>
              <h2 className="adhoc-section-title">Critical Application Health</h2>
              <p className="adhoc-section-desc">Real-time status overview across the 4 core monitored CDK platforms.</p>
            </div>
            <div className="adhoc-kpi-summary">
              <span className="adhoc-kpi-pill success">
                <i className="fa-solid fa-circle-check"></i> {data.report.passedChecks} Checks Passing
              </span>
              {data.report.failedChecks > 0 && (
                <span className="adhoc-kpi-pill danger">
                  <i className="fa-solid fa-circle-exclamation"></i> {data.report.failedChecks} Check Attention
                </span>
              )}
              <span className="adhoc-kpi-pill info">
                <i className="fa-solid fa-gauge-high"></i> {data.report.overallAvailability}% Availability
              </span>
            </div>
          </div>

          <div className="adhoc-cards-grid">
            {data.applications.map(app => {
              const isAttention = app.status === 'ATTENTION';
              return (
                <div
                  key={app.id}
                  className={`adhoc-app-card ${isAttention ? 'attention-card' : 'healthy-card'}`}
                  id={`card-app-${app.id}`}
                >
                  <div className="adhoc-card-header">
                    <div className="adhoc-card-title-group">
                      <h3 className="adhoc-app-name">{app.name}</h3>
                      <p className="adhoc-app-business">{app.businessArea}</p>
                    </div>
                    <span className={`adhoc-status-chip ${isAttention ? 'status-attention' : 'status-healthy'}`}>
                      <i className={`fa-solid ${isAttention ? 'fa-triangle-exclamation' : 'fa-circle-check'}`}></i>
                      <span>{app.status}</span>
                    </span>
                  </div>

                  <p className="adhoc-card-desc">{app.description}</p>

                  <div className="adhoc-card-signals">
                    {/* Playwright */}
                    <div className="adhoc-signal-row">
                      <span className="adhoc-signal-label">
                        <i className="fa-solid fa-vial-virus"></i> Playwright:
                      </span>
                      <span className={`adhoc-signal-value ${app.playwright.status === 'PASS' ? 'text-success' : 'text-danger'}`}>
                        {app.playwright.status} ({app.playwright.testsPassed}/{app.playwright.testsRun})
                      </span>
                    </div>

                    {/* New Relic */}
                    <div className="adhoc-signal-row">
                      <span className="adhoc-signal-label">
                        <i className="fa-solid fa-chart-line"></i> New Relic:
                      </span>
                      <span className="adhoc-signal-value">
                        {app.newRelic.synthetics} ({app.newRelic.latency})
                      </span>
                    </div>

                    {/* DevOps */}
                    <div className="adhoc-signal-row">
                      <span className="adhoc-signal-label">
                        <i className="fa-brands fa-github"></i> CI / CD:
                      </span>
                      <span className="adhoc-signal-value">
                        {app.devOps.githubStatus} / {app.devOps.harnessStatus}
                      </span>
                    </div>

                    {/* SSL */}
                    <div className="adhoc-signal-row">
                      <span className="adhoc-signal-label">
                        <i className="fa-solid fa-lock"></i> SSL Cert:
                      </span>
                      <span className="adhoc-signal-value">
                        {app.ssl.daysRemaining} days remaining
                      </span>
                    </div>
                  </div>

                  <div className="adhoc-card-footer">
                    <button
                      type="button"
                      className="adhoc-teams-channel-btn"
                      onClick={() => handleOpenTeams(app.teamsChannel)}
                      title={`Open ${app.teamsChannel} in Microsoft Teams`}
                    >
                      <i className="fa-brands fa-microsoft"></i>
                      <span>{app.teamsChannel}</span>
                    </button>
                    <button
                      type="button"
                      className="adhoc-drill-btn"
                      onClick={() => setExpandedAppId(expandedAppId === app.id ? null : app.id)}
                      title="Inspect detailed telemetry metrics"
                    >
                      <span>{expandedAppId === app.id ? 'Hide' : 'Details'}</span>
                      <i className={`fa-solid ${expandedAppId === app.id ? 'fa-chevron-up' : 'fa-chevron-down'}`}></i>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Consolidated Health & Observability Matrix (Detailed Table) */}
        <section className="adhoc-matrix-section">
          <div className="adhoc-matrix-toolbar">
            <div className="adhoc-matrix-heading">
              <h2 className="adhoc-section-title">Consolidated Observability Matrix</h2>
              <p className="adhoc-section-desc">Unified cross-application telemetry, synthetic verification, and delivery matrix.</p>
            </div>

            <div className="adhoc-filter-controls">
              <div className="adhoc-search-box">
                <i className="fa-solid fa-magnifying-glass"></i>
                <input
                  type="text"
                  placeholder="Filter applications or components..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
                {searchTerm && (
                  <button className="adhoc-search-clear" onClick={() => setSearchTerm('')}>
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                )}
              </div>

              <div className="adhoc-filter-group" role="group" aria-label="Status filter">
                <button
                  type="button"
                  className={`adhoc-filter-pill ${statusFilter === 'ALL' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('ALL')}
                >
                  All ({data.applications.length})
                </button>
                <button
                  type="button"
                  className={`adhoc-filter-pill ${statusFilter === 'ATTENTION' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('ATTENTION')}
                >
                  Attention ({data.applications.filter(a => a.status === 'ATTENTION').length})
                </button>
                <button
                  type="button"
                  className={`adhoc-filter-pill ${statusFilter === 'HEALTHY' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('HEALTHY')}
                >
                  Healthy ({data.applications.filter(a => a.status === 'HEALTHY').length})
                </button>
              </div>

              <button
                type="button"
                className="adhoc-btn adhoc-btn-sm adhoc-btn-outline"
                onClick={() => setIsEmailPreviewOpen(true)}
              >
                <i className="fa-regular fa-file-lines"></i>
                <span>Email Report Preview</span>
              </button>
            </div>
          </div>

          <div className="adhoc-table-wrapper">
            <table className="adhoc-table">
              <thead>
                <tr>
                  <th style={{ width: '22%' }}>Application</th>
                  <th style={{ width: '15%' }}>Playwright UI</th>
                  <th style={{ width: '16%' }}>New Relic (APM)</th>
                  <th style={{ width: '14%' }}>Cribl Telemetry</th>
                  <th style={{ width: '15%' }}>DevOps Pipeline</th>
                  <th style={{ width: '10%' }}>SSL Certificate</th>
                  <th style={{ width: '8%' }}>Teams Channel</th>
                </tr>
              </thead>
              <tbody>
                {filteredApps.map(app => {
                  const isExpanded = expandedAppId === app.id;
                  const isAttention = app.status === 'ATTENTION';

                  return (
                    <React.Fragment key={app.id}>
                      <tr className={`adhoc-row ${isAttention ? 'row-attention' : ''} ${isExpanded ? 'row-expanded' : ''}`}>
                        <td>
                          <div className="adhoc-app-cell">
                            <button
                              type="button"
                              className="adhoc-expand-trigger"
                              onClick={() => setExpandedAppId(isExpanded ? null : app.id)}
                            >
                              <i className={`fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'}`}></i>
                            </button>
                            <div>
                              <strong className="adhoc-cell-title">{app.name}</strong>
                              <span className="adhoc-cell-sub">{app.businessArea}</span>
                            </div>
                          </div>
                        </td>

                        <td>
                          <span className={`adhoc-status-badge ${app.playwright.status === 'PASS' ? 'badge-pass' : 'badge-fail'}`}>
                            <i className={`fa-solid ${app.playwright.status === 'PASS' ? 'fa-check' : 'fa-xmark'}`}></i>
                            {app.playwright.status} ({app.playwright.testsPassed}/{app.playwright.testsRun})
                          </span>
                          <span className="adhoc-cell-sub">{app.playwright.duration} • {new Date(app.playwright.lastCheck).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </td>

                        <td>
                          <div className="adhoc-apm-cell">
                            <span className="adhoc-uptime-badge">{app.newRelic.synthetics}</span>
                            <span className="adhoc-cell-sub">{app.newRelic.latency} • {app.newRelic.apmStatus}</span>
                          </div>
                        </td>

                        <td>
                          <div className="adhoc-cribl-cell">
                            <span className="adhoc-chip-neutral"><i className="fa-solid fa-wave-square"></i> {app.cribl.rate}</span>
                            <span className="adhoc-cell-sub">{app.cribl.pipeline}</span>
                          </div>
                        </td>

                        <td>
                          <div className="adhoc-devops-cell">
                            <span className="adhoc-chip-github"><i className="fa-brands fa-github"></i> {app.devOps.githubStatus}</span>
                            <span className="adhoc-cell-sub">{app.devOps.harnessPipeline}</span>
                          </div>
                        </td>

                        <td>
                          <span className="adhoc-status-badge badge-pass">
                            <i className="fa-solid fa-shield"></i> VALID
                          </span>
                          <span className="adhoc-cell-sub">{app.ssl.daysRemaining}d left</span>
                        </td>

                        <td>
                          <button
                            type="button"
                            className="adhoc-cell-teams-btn"
                            onClick={() => handleOpenTeams(app.teamsChannel)}
                          >
                            <i className="fa-brands fa-microsoft"></i> {app.teamsChannel}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Deep-Dive Drilldown Drawer */}
                      {isExpanded && (
                        <tr className="adhoc-drawer-row">
                          <td colSpan={7}>
                            <div className="adhoc-drawer-content">
                              <div className="adhoc-drawer-header">
                                <h4><i className="fa-solid fa-microscope"></i> Deep Diagnostics: {app.name}</h4>
                                <span className="adhoc-drawer-id">ID: {app.id} • Host Domain: {app.ssl.domain}</span>
                              </div>

                              <div className="adhoc-drawer-grid">
                                <div className="adhoc-drawer-card">
                                  <span className="adhoc-card-label">Playwright E2E Diagnostics</span>
                                  <div className="adhoc-drawer-stat">Passed: {app.playwright.testsPassed} / {app.playwright.testsRun}</div>
                                  <div className="adhoc-drawer-stat">Suite Duration: {app.playwright.duration}</div>
                                  {app.playwright.failedTest ? (
                                    <div className="adhoc-drawer-error">
                                      <i className="fa-solid fa-bug"></i> Failed Test: {app.playwright.failedTest}
                                    </div>
                                  ) : (
                                    <div className="adhoc-drawer-ok">
                                      <i className="fa-solid fa-check"></i> All synthetic scenarios passed without regression.
                                    </div>
                                  )}
                                </div>

                                <div className="adhoc-drawer-card">
                                  <span className="adhoc-card-label">New Relic APM & Synthetics</span>
                                  <div className="adhoc-drawer-stat">Synthetics Uptime: {app.newRelic.synthetics}</div>
                                  <div className="adhoc-drawer-stat">P95 Response Latency: {app.newRelic.latency}</div>
                                  <div className="adhoc-drawer-stat">Apdex User Experience: {app.newRelic.apmStatus}</div>
                                  <div className="adhoc-drawer-stat">Application Error Rate: {app.newRelic.errorRate}</div>
                                </div>

                                <div className="adhoc-drawer-card">
                                  <span className="adhoc-card-label">DevOps & SSL Transport</span>
                                  <div className="adhoc-drawer-stat">GitHub Workflow: {app.devOps.githubWorkflow}</div>
                                  <div className="adhoc-drawer-stat">Harness Deployment: {app.devOps.harnessPipeline}</div>
                                  <div className="adhoc-drawer-stat">Cert Issuer: {app.ssl.issuer}</div>
                                  <div className="adhoc-drawer-stat">Expiry Window: {app.ssl.daysRemaining} days</div>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Microsoft Teams Alert-Routing Feed */}
        <section className="adhoc-teams-section">
          <div className="adhoc-section-header">
            <div>
              <h2 className="adhoc-section-title">
                <i className="fa-brands fa-microsoft adhoc-teams-logo"></i> Microsoft Teams Alert-Routing Feed
              </h2>
              <p className="adhoc-section-desc">Chronological dispatch log of real-time incident notifications routed to engineering channels.</p>
            </div>
          </div>

          <div className="adhoc-feed-list">
            {data.alerts.map(alert => {
              const isCrit = alert.severity === 'CRITICAL';
              const isResolved = alert.severity === 'RESOLVED';

              return (
                <div
                  key={alert.id}
                  className={`adhoc-feed-item ${isCrit ? 'feed-critical' : isResolved ? 'feed-resolved' : 'feed-info'}`}
                >
                  <div className="adhoc-feed-left">
                    <span className={`adhoc-sev-badge ${isCrit ? 'sev-crit' : isResolved ? 'sev-res' : 'sev-info'}`}>
                      {alert.severity}
                    </span>
                    <div className="adhoc-feed-info">
                      <div className="adhoc-feed-topline">
                        <strong className="adhoc-feed-app">{alert.application}</strong>
                        <span className="adhoc-feed-comp">• {alert.component}</span>
                        <span className="adhoc-feed-channel"><i className="fa-brands fa-microsoft"></i> {alert.channel}</span>
                      </div>
                      <p className="adhoc-feed-summary">{alert.summary}</p>
                    </div>
                  </div>

                  <div className="adhoc-feed-right">
                    <span className="adhoc-feed-time">
                      {new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} UTC
                    </span>
                    <button
                      type="button"
                      className="adhoc-btn adhoc-btn-xs adhoc-btn-outline"
                      onClick={() => handleOpenTeams(alert)}
                    >
                      <i className="fa-solid fa-arrow-up-right-from-square"></i>
                      <span>View in Teams</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        </>
        )}
      </div>

      {/* Teams Channel Modal Simulator */}
      {teamsModalAlert && (
        <div className="adhoc-modal-backdrop" onClick={() => setTeamsModalAlert(null)}>
          <div className="adhoc-teams-dialog" onClick={e => e.stopPropagation()}>
            <div className="adhoc-teams-dialog-header">
              <div className="adhoc-teams-brand">
                <i className="fa-brands fa-microsoft"></i>
                <span>Microsoft Teams Alert Dispatcher</span>
              </div>
              <button className="adhoc-dialog-close" onClick={() => setTeamsModalAlert(null)}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="adhoc-teams-dialog-body">
              <div className="adhoc-teams-channel-info">
                <h3>Channel: <code>{teamsModalAlert.channel}</code></h3>
                <p>Application: <strong>{teamsModalAlert.application}</strong></p>
              </div>
              <div className="adhoc-teams-msg-card">
                <div className="adhoc-teams-msg-sender">
                  <div className="adhoc-teams-bot-avatar">NOVA</div>
                  <div>
                    <strong>NOVA Validation Bot</strong>
                    <span>Automated Dispatch</span>
                  </div>
                </div>
                <p className="adhoc-teams-msg-text">{teamsModalAlert.summary}</p>
                <div className="adhoc-teams-msg-meta">
                  <span>Timestamp: {new Date().toUTCString()}</span>
                  <span>Alert Status: ACTIVE ROUTE</span>
                </div>
              </div>
            </div>
            <div className="adhoc-teams-dialog-footer">
              <a
                href={teamsModalAlert.teamsUrl || 'https://teams.microsoft.com'}
                target="_blank"
                rel="noreferrer"
                className="adhoc-btn adhoc-btn-primary"
                onClick={() => setTeamsModalAlert(null)}
              >
                <i className="fa-solid fa-arrow-up-right-from-square"></i>
                <span>Launch in Microsoft Teams</span>
              </a>
              <button
                type="button"
                className="adhoc-btn adhoc-btn-secondary"
                onClick={() => setTeamsModalAlert(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run Validation Progress Dialog */}
      <RunValidationDialog
        isOpen={isRunValidationOpen}
        onClose={() => setIsRunValidationOpen(false)}
        onComplete={handleValidationComplete}
      />

      {/* Email Report Preview Dialog */}
      <EmailReportPreviewDialog
        isOpen={isEmailPreviewOpen}
        onClose={() => setIsEmailPreviewOpen(false)}
        data={data}
      />
    </div>
  );
}
