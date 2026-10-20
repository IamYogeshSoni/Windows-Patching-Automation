import React from 'react'
import './Header.css'

export default function Header({ selectedCount = 0, totalServers = 0 }) {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <header className="app-header" id="app-header">
      <div className="header-left">
        <div className="page-title">
          <h1>Windows Patching Automation</h1>
          <p className="page-subtitle">
            <i className="fa-solid fa-shield-halved"></i>
            Autonomous Patch Management Pipeline
          </p>
        </div>
      </div>

      <div className="header-right">
        <div className="header-badge syncing" id="badge-servicenow">
          <i className="fa-solid fa-arrows-rotate fa-spin"></i>
          <span>ServiceNow Syncing</span>
        </div>

        <div className="header-badge success" id="badge-agent">
          <div className="pulse-dot"></div>
          <span>Agent Online</span>
        </div>

        <div className="header-time">
          <i className="fa-regular fa-clock"></i>
          <span>{timeStr}</span>
        </div>
      </div>
    </header>
  )
}
