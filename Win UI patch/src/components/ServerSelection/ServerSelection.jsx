import React, { useState, useMemo } from 'react'
import Select from 'react-select'
import './ServerSelection.css'

const customStyles = {
  control: (provided, state) => ({
    ...provided,
    backgroundColor: 'var(--bg-glass)',
    borderColor: state.isFocused ? 'var(--accent)' : 'var(--border-glass)',
    boxShadow: state.isFocused ? 'var(--focus-ring)' : null,
    minHeight: '36px',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-main)',
    '&:hover': {
      borderColor: 'var(--border-glass-strong)'
    }
  }),
  menu: (provided) => ({
    ...provided,
    backgroundColor: 'var(--bg-elevated)',
    boxShadow: 'var(--shadow-pop)',
    border: '1px solid var(--border-glass-strong)',
    borderRadius: 'var(--radius-md)',
    backdropFilter: 'blur(16px)',
    zIndex: 999
  }),
  option: (provided, state) => ({
    ...provided,
    backgroundColor: state.isSelected 
      ? 'var(--accent-dim)' 
      : state.isFocused 
        ? 'var(--bg-glass-hover)' 
        : 'transparent',
    color: state.isSelected ? 'var(--accent-text)' : 'var(--text-main)',
    cursor: 'pointer',
    fontSize: '13px',
    '&:active': {
      backgroundColor: 'var(--accent-dim)'
    }
  }),
  multiValue: (provided) => ({
    ...provided,
    backgroundColor: 'var(--accent-dim)',
    borderRadius: '4px',
    border: '1px solid var(--accent-border)'
  }),
  multiValueLabel: (provided) => ({
    ...provided,
    color: 'var(--accent-text)',
    fontWeight: '500',
    fontSize: '12px'
  }),
  multiValueRemove: (provided) => ({
    ...provided,
    color: 'var(--accent-text)',
    '&:hover': {
      backgroundColor: 'var(--accent)',
      color: 'var(--on-accent)',
    }
  }),
  placeholder: (provided) => ({
    ...provided,
    color: 'var(--text-dimmed)',
    fontSize: '13px'
  }),
  input: (provided) => ({
    ...provided,
    color: 'var(--text-main)'
  }),
  singleValue: (provided) => ({
    ...provided,
    color: 'var(--text-main)'
  })
}

export default function ServerSelection({ servers, selectedServers, onSelectionChange, onProceed }) {
  const [sortBy, setSortBy] = useState('name')
  const [sortDir, setSortDir] = useState('asc')

  const sortedServers = useMemo(() => {
    let result = [...servers]

    // Sort
    result.sort((a, b) => {
      let aVal = a[sortBy], bVal = b[sortBy]
      if (sortBy === 'criticalUpdates') { aVal = Number(aVal); bVal = Number(bVal) }
      if (typeof aVal === 'string') { aVal = aVal.toLowerCase(); bVal = bVal.toLowerCase() }
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1
      return 0
    })

    return result
  }, [servers, sortBy, sortDir])

  const allFilteredSelected = sortedServers.length > 0 &&
    sortedServers.every(s => selectedServers.includes(s.id))

  const toggleServer = (id) => {
    if (selectedServers.includes(id)) {
      onSelectionChange(selectedServers.filter(sid => sid !== id))
    } else {
      onSelectionChange([...selectedServers, id])
    }
  }

  const toggleAll = () => {
    if (allFilteredSelected) {
      const filteredIds = sortedServers.map(s => s.id)
      onSelectionChange(selectedServers.filter(id => !filteredIds.includes(id)))
    } else {
      const newSelection = new Set([...selectedServers, ...sortedServers.map(s => s.id)])
      onSelectionChange([...newSelection])
    }
  }

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir('asc')
    }
  }

  const getStatusClass = (status) => {
    switch (status) {
      case 'online': return 'status-online'
      case 'offline': return 'status-offline'
      case 'maintenance': return 'status-maintenance'
      default: return ''
    }
  }

  const getDaysSince = (dateStr) => {
    const d = new Date(dateStr)
    const now = new Date()
    return Math.floor((now - d) / (1000 * 60 * 60 * 24))
  }

  // Map options for react-select
  const selectOptions = useMemo(() => {
    return servers.map(s => ({
      value: s.id,
      label: `${s.name} (${s.ip})`
    }))
  }, [servers])

  // Map selected values for react-select value prop
  const selectedOptions = useMemo(() => {
    return selectOptions.filter(opt => selectedServers.includes(opt.value))
  }, [selectOptions, selectedServers])

  const handleSelectChange = (selected) => {
    const ids = selected ? selected.map(opt => opt.value) : []
    onSelectionChange(ids)
  }

  return (
    <div className="server-selection animate-fade-in" id="server-selection">
      {/* Toolbar */}
      <div className="selection-toolbar">
        <div className="toolbar-left" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <i className="fa-solid fa-server" style={{ color: 'var(--text-dimmed)', fontSize: '18px' }}></i>
          <div style={{ flex: 1, maxWidth: '600px' }}>
            <Select
              isMulti
              options={selectOptions}
              value={selectedOptions}
              onChange={handleSelectChange}
              placeholder="Search and select servers by name..."
              styles={customStyles}
              className="react-select-container"
              classNamePrefix="react-select"
            />
          </div>
        </div>
        <div className="toolbar-right">
          <div className="selection-counter" id="selection-counter">
            <span className="counter-number">{selectedServers.length}</span>
            <span className="counter-text">of {servers.length} selected</span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="server-table-wrapper glass">
        <table className="server-table" id="server-table">
          <thead>
            <tr>
              <th className="col-check">
                <label className="custom-checkbox">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAll}
                    id="select-all-checkbox"
                  />
                  <span className="checkmark"></span>
                </label>
              </th>
              <th className="sortable" onClick={() => handleSort('name')}>
                Server Name {sortBy === 'name' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th className="sortable" onClick={() => handleSort('ip')}>
                IP Address {sortBy === 'ip' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th className="sortable" onClick={() => handleSort('os')}>
                OS Version {sortBy === 'os' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th className="sortable" onClick={() => handleSort('environment')}>
                Env {sortBy === 'environment' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th className="sortable" onClick={() => handleSort('group')}>
                Group {sortBy === 'group' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th className="sortable" onClick={() => handleSort('criticalUpdates')}>
                Updates {sortBy === 'criticalUpdates' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th className="sortable" onClick={() => handleSort('lastPatched')}>
                Last Patched {sortBy === 'lastPatched' && <i className={`fa-solid fa-sort-${sortDir === 'asc' ? 'up' : 'down'}`}></i>}
              </th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedServers.map((server, i) => {
              const isSelected = selectedServers.includes(server.id)
              const daysSince = getDaysSince(server.lastPatched)
              return (
                <tr
                  key={server.id}
                  className={`server-row ${isSelected ? 'selected' : ''} ${server.status === 'offline' ? 'dimmed' : ''}`}
                  onClick={() => toggleServer(server.id)}
                  style={{ animationDelay: `${i * 25}ms` }}
                >
                  <td className="col-check">
                    <label className="custom-checkbox" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleServer(server.id)}
                      />
                      <span className="checkmark"></span>
                    </label>
                  </td>
                  <td className="col-name">
                    <div className="server-name-cell">
                      <i className="fa-solid fa-server server-icon"></i>
                      <div>
                        <span className="server-name">{server.name}</span>
                        <span className="server-id">{server.id}</span>
                      </div>
                    </div>
                  </td>
                  <td className="col-ip">
                    <code>{server.ip}</code>
                  </td>
                  <td className="col-os">
                    <span className="os-badge">{server.os.replace('Windows Server ', 'WS ')}</span>
                  </td>
                  <td>
                    <span className={`env-badge env-${server.environment.toLowerCase()}`}>
                      {server.environment === 'Production' ? 'Prod' : server.environment === 'Development' ? 'Dev' : server.environment}
                    </span>
                  </td>
                  <td className="col-group">{server.group}</td>
                  <td className="col-updates">
                    {server.criticalUpdates > 0 ? (
                      <span className={`update-badge ${server.criticalUpdates >= 5 ? 'high' : server.criticalUpdates >= 3 ? 'medium' : 'low'}`}>
                        {server.criticalUpdates}
                      </span>
                    ) : (
                      <span className="update-badge none">0</span>
                    )}
                  </td>
                  <td className="col-patched">
                    <span className={daysSince > 45 ? 'text-danger' : daysSince > 30 ? 'text-warning' : ''}>
                      {daysSince}d ago
                    </span>
                  </td>
                  <td>
                    <span className={`status-indicator ${getStatusClass(server.status)}`}>
                      <span className="status-dot"></span>
                      {server.status.charAt(0).toUpperCase() + server.status.slice(1)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Bottom Action Bar */}
      <div className="action-bar" style={{ marginTop: 'auto' }}>
        <div className="action-bar-info">
          {selectedServers.length > 0 ? (
            <>
              <i className="fa-solid fa-circle-check" style={{ color: 'var(--success)' }}></i>
              <span><strong>{selectedServers.length}</strong> server{selectedServers.length !== 1 ? 's' : ''} ready for pre-check validation</span>
            </>
          ) : (
            <>
              <i className="fa-solid fa-circle-info" style={{ color: 'var(--text-muted)' }}></i>
              <span>Select at least one server to proceed</span>
            </>
          )}
        </div>
        <button
          className="btn-proceed"
          disabled={selectedServers.length === 0}
          onClick={onProceed}
          id="btn-proceed-precheck"
        >
          Proceed to Pre-check
          <i className="fa-solid fa-arrow-right"></i>
        </button>
      </div>
    </div>
  )
}
