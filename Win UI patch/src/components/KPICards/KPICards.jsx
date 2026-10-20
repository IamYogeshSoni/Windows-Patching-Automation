import React from 'react'
import './KPICards.css'

export default function KPICards({ servers = [], selectedServers = [] }) {
  const totalServers = servers.length
  const onlineServers = servers.filter(s => s.status === 'online').length
  const totalCritical = servers.reduce((sum, s) => sum + s.criticalUpdates, 0)
  const needPatching = servers.filter(s => s.criticalUpdates > 0).length

  const prodCount = servers.filter(s => s.environment === 'Production').length
  const devCount = servers.filter(s => s.environment === 'Development').length
  const uatCount = servers.filter(s => s.environment === 'UAT').length

  const prodPct = (prodCount / totalServers) * 100
  const devPct = (devCount / totalServers) * 100
  const uatPct = (uatCount / totalServers) * 100

  const kpis = [
    {
      id: 'kpi-total',
      label: 'Total Servers',
      value: totalServers,
      icon: 'fa-server',
      iconColor: 'var(--accent-text)',
      iconBg: 'var(--accent-dim)',
      trend: `${onlineServers} Online`,
      trendType: 'up',
      trendIcon: 'fa-circle-check',
    },
    {
      id: 'kpi-selected',
      label: 'Selected for Patching',
      value: selectedServers.length,
      icon: 'fa-check-double',
      iconColor: 'var(--secondary)',
      iconBg: 'var(--secondary-dim)',
      trend: `of ${totalServers} servers`,
      trendType: 'neutral',
      trendIcon: 'fa-layer-group',
    },
    {
      id: 'kpi-critical',
      label: 'Critical Updates',
      value: totalCritical,
      icon: 'fa-triangle-exclamation',
      iconColor: 'var(--warning)',
      iconBg: 'var(--warning-dim)',
      trend: `${needPatching} servers affected`,
      trendType: 'warn',
      trendIcon: 'fa-arrow-trend-up',
    },
  ]

  return (
    <div className="kpi-grid" id="kpi-grid">
      {kpis.map((kpi, i) => (
        <div
          key={kpi.id}
          className="kpi-card glass"
          id={kpi.id}
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="kpi-header">
            <span className="kpi-label">{kpi.label}</span>
            <div className="kpi-icon" style={{ background: kpi.iconBg, color: kpi.iconColor }}>
              <i className={`fa-solid ${kpi.icon}`}></i>
            </div>
          </div>
          <div className="kpi-value">{kpi.value}</div>
          <div className={`kpi-trend trend-${kpi.trendType}`}>
            <i className={`fa-solid ${kpi.trendIcon}`}></i>
            <span>{kpi.trend}</span>
          </div>
        </div>
      ))}

      <div className="kpi-card glass kpi-graph-card" style={{ animationDelay: '240ms' }}>
        <div className="kpi-header" style={{ marginBottom: '16px' }}>
          <span className="kpi-label">Environment Breakdown</span>
          <div className="kpi-icon" style={{ background: 'var(--bg-subtle)', color: 'var(--text-main)' }}>
            <i className="fa-solid fa-chart-pie"></i>
          </div>
        </div>
        
        <div className="env-graph-container">
          <div className="env-graph-bar">
            <div className="env-segment prod" style={{ width: `${prodPct}%` }}></div>
            <div className="env-segment uat" style={{ width: `${uatPct}%` }}></div>
            <div className="env-segment dev" style={{ width: `${devPct}%` }}></div>
          </div>
          
          <div className="env-legend">
            <div className="legend-item">
              <span className="legend-color prod-color"></span>
              <span className="legend-text">Prod {prodCount}</span>
            </div>
            <div className="legend-item">
              <span className="legend-color uat-color"></span>
              <span className="legend-text">UAT {uatCount}</span>
            </div>
            <div className="legend-item">
              <span className="legend-color dev-color"></span>
              <span className="legend-text">Dev {devCount}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
