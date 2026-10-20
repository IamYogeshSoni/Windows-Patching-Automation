import React from 'react'
import './History.css'

export default function History() {
  return (
    <section className="history-page animate-fade-in" id="history-view">
      <div className="history-header">
        <div>
          <h1>Patch History</h1>
          <p>Previous patching sessions will appear here once available from the database.</p>
        </div>
      </div>

      <div className="history-placeholder-card glass">
        <div className="history-placeholder-icon">
          <i className="fa-solid fa-clock-rotate-left"></i>
        </div>
        <div className="history-placeholder-content">
          <h2>No patch history yet</h2>
          <p>
            Currently there are no historical patch results to display. This section will show
            completed patch cycles, server status changes, and audit information once the backend
            stores patch history details.
          </p>
        </div>
      </div>
    </section>
  )
}
