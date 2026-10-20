import React from 'react'
import './Sidebar.css'

const navItems = [
  { icon: 'fa-compass', label: 'Win Patching', id: 'enterprise-portal', hidden: true },
  { icon: 'fa-windows', iconStyle: 'fa-brands', label: 'Windows Patching', id: 'windows-patching' },
  { icon: 'fa-diagram-project', label: 'Patch Pipeline', id: 'patch-pipeline' },
  { icon: 'fa-bolt', label: 'Ad-Hoc Execution', id: 'adhoc-execution' },
  { icon: 'fa-clock-rotate-left', label: 'History', id: 'history' },
  { icon: 'fa-linux', label: 'Linux Patching', id: 'linux-patching', hidden: true },
  { icon: 'fa-windows', label: 'WinPatching1', id: 'live-sessions', hidden: true },
]



export default function Sidebar({ activeNav = 'enterprise-portal', onNavChange, collapsed = false, onToggleCollapse, theme }) {
  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} id="sidebar-nav">
      {/* Toggle Button */}
      <button
        className="sidebar-toggle-btn"
        onClick={onToggleCollapse}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        id="sidebar-toggle"
      >
        <i className={`fa-solid ${collapsed ? 'fa-angles-right' : 'fa-angles-left'}`}></i>
      </button>

      <div className="sidebar-nav-list">
        {navItems.filter(item => !item.hidden).map(item => (
          <a
            key={item.id}
            href={`/unified/${item.id}`}
            className={`sidebar-nav-item ${activeNav === item.id ? 'active' : ''}`}
            id={`nav-${item.id}`}
            title={collapsed ? item.label : ''}
            aria-current={activeNav === item.id ? 'page' : undefined}
            onClick={(e) => {
              // Let ctrl/cmd/shift/middle-click open the tab's URL in a new browser tab
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              if (onNavChange) onNavChange(item.id);
            }}
          >
            <i className={`${item.iconStyle || 'fa-solid'} ${item.icon}`}></i>
            {!collapsed && <span>{item.label}</span>}
          </a>
        ))}
      </div>
    </nav>
  )
}
