import React, { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar/Sidebar'
import Header from './components/Header/Header'
import KPICards from './components/KPICards/KPICards'
import Stepper from './components/Stepper/Stepper'
import ServerSelection from './components/ServerSelection/ServerSelection'
import PreCheck from './components/PreCheck/PreCheck'
import PostCheck from './components/PostCheck/PostCheck'
import Summary from './components/Summary/Summary'
import LinuxPatching from './components/LinuxPatching/LinuxPatching'
import LiveSessions from './components/LiveSessions/LiveSessions'
import EnterprisePortal from './components/EnterprisePortal/EnterprisePortal'
import History from './components/History/History'
import Chatbot from './components/Chatbot/Chatbot'
import PatchPipeline from './components/PatchPipeline/PatchPipeline'
import AdHocExecution from './components/AdHocExecution/AdHocExecution'
import WindowsPatching from './components/WindowsPatching/WindowsPatching'
import allServers from './data/servers'
import './App.css'

const ROUTES = {
  HOME: '/',
  UNIFIED: '/unified'
}

// Each Unified Patching tab has its own URL: /unified/<view>
const UNIFIED_VIEWS = {
  'windows-patching': 'Windows Patching',
  'patch-pipeline': 'Patch Pipeline',
  'adhoc-execution': 'Ad-Hoc Execution',
  'history': 'History'
}
const DEFAULT_VIEW = 'windows-patching'
const viewRoute = (view) => `${ROUTES.UNIFIED}/${view}`

const NAV_ITEMS = [
  { route: ROUTES.HOME, label: 'Home', icon: 'fa-house' }
]

const WORKSPACE_TILES = [
  {
    route: ROUTES.UNIFIED,
    title: 'Windows Patching',
    description: 'Readiness checks, one-click SCCM deployment, live tracking and reports.',
    icon: 'fa-windows',
    iconStyle: 'fa-brands'
  }
]

// Map any incoming path to a canonical route; unknown tabs fall back to the default tab
const normalizeRoute = (pathname) => {
  let path = (pathname || ROUTES.HOME).replace(/\/+$/, '') || ROUTES.HOME
  path = path.replace(/^\/unfied(?=\/|$)/, ROUTES.UNIFIED)
  if (path === ROUTES.UNIFIED) return viewRoute(DEFAULT_VIEW)
  if (path.startsWith(`${ROUTES.UNIFIED}/`)) {
    const view = path.slice(ROUTES.UNIFIED.length + 1)
    return UNIFIED_VIEWS[view] ? viewRoute(view) : viewRoute(DEFAULT_VIEW)
  }
  return ROUTES.HOME
}

const viewFromRoute = (route) =>
  route.startsWith(`${ROUTES.UNIFIED}/`) ? route.slice(ROUTES.UNIFIED.length + 1) : null

// Keep the address bar on the canonical URL (e.g. /unified -> /unified/patch-pipeline)
const syncAddressBar = (route) => {
  if (window.location.pathname !== route) {
    window.history.replaceState({}, '', route + window.location.search + window.location.hash)
  }
}

export default function App() {
  const [route, setRoute] = useState(() => normalizeRoute(window.location.pathname))
  const currentView = viewFromRoute(route)
  const [currentStep, setCurrentStep] = useState(1)
  const [selectedServers, setSelectedServers] = useState([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)

  // Lifted theme state — shared between Sidebar and EnterprisePortal.
  // index.html sets <html data-theme> before first paint; start from that.
  const [theme, setTheme] = useState(() => {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  })

  // Sync theme to the root element and localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('NOVA-enterprise-theme', theme)
    } catch {
      // Storage can be unavailable (private mode, blocked site data) — theme still applies
    }
  }, [theme])

  useEffect(() => {
    const handlePopState = () => {
      const next = normalizeRoute(window.location.pathname)
      syncAddressBar(next)
      setRoute(next)
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Canonicalise the URL on first load and keep the browser tab title in step with the route
  useEffect(() => {
    syncAddressBar(route)
    document.title = currentView ? `NOVA | ${UNIFIED_VIEWS[currentView]}` : 'NOVA | Windows Patching Automation'
  }, [route, currentView])

  const navigateTo = (path) => {
    const nextRoute = normalizeRoute(path)
    if (window.location.pathname !== nextRoute) {
      window.history.pushState({}, '', nextRoute)
    }
    setRoute(nextRoute)
  }

  const setCurrentView = (view) => navigateTo(viewRoute(view))

  const handleToggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }

  const handleStepClick = (step) => {
    if (step < currentStep) {
      setCurrentStep(step)
    }
  }

  const handleRestart = () => {
    setCurrentStep(1)
    setSelectedServers([])
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <ServerSelection
            servers={allServers}
            selectedServers={selectedServers}
            onSelectionChange={setSelectedServers}
            onProceed={() => setCurrentStep(2)}
          />
        )
      case 2:
        return (
          <PreCheck
            key="precheck"
            selectedServerIds={selectedServers}
            allServers={allServers}
            onProceed={() => setCurrentStep(3)}
            onBack={() => setCurrentStep(1)}
          />
        )
      case 3:
        return (
          <PostCheck
            key="postcheck"
            selectedServerIds={selectedServers}
            allServers={allServers}
            onProceed={() => setCurrentStep(4)}
            onBack={() => setCurrentStep(2)}
          />
        )
      case 4:
        return (
          <Summary
            selectedServerIds={selectedServers}
            allServers={allServers}
            onRestart={handleRestart}
          />
        )
      default:
        return null
    }
  }

  const renderAppNav = () => (
    <header className="global-nav">
      <button
        type="button"
        className="global-brand"
        onClick={() => navigateTo(ROUTES.HOME)}
        aria-label="Go to home"
      >
        <span className="global-brand-text">NOVA</span>
      </button>

      <nav className="global-nav-links" aria-label="Primary navigation">
        {NAV_ITEMS.map(item => (
          <button
            key={item.route}
            type="button"
            className={`global-nav-link ${route === item.route ? 'active' : ''}`}
            onClick={() => navigateTo(item.route)}
          >
            <i className={`fa-solid ${item.icon}`}></i>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="global-nav-actions">
        <button
          type="button"
          className="global-icon-btn"
          onClick={handleToggleTheme}
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          {theme === 'light' ? (
            <i className="fa-solid fa-sun"></i>
          ) : (
            <i className="fa-solid fa-moon"></i>
          )}
        </button>

      </div>
    </header>
  )

  const renderUnifiedApp = () => (
    <div className="app-root">
      <Sidebar
        activeNav={currentView}
        onNavChange={setCurrentView}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
        theme={theme}
      />
      <main
        className={`main-content ${currentView === 'enterprise-portal' ? 'ep-view-active' : ''} ${currentView === 'patch-pipeline' ? 'pp-view-active' : ''} ${currentView === 'adhoc-execution' ? 'adhoc-view-active' : ''} ${currentView === 'windows-patching' ? 'wp-view-active' : ''}`}
        id="main-content"
      >
        {currentView === 'win-patching' ? (
          <>
            <Header
              selectedCount={selectedServers.length}
              totalServers={allServers.length}
            />
            <KPICards
              servers={allServers}
              selectedServers={selectedServers}
            />
            <Stepper
              currentStep={currentStep}
              onStepClick={handleStepClick}
            />
            <div className="step-content">
              {renderStepContent()}
            </div>
          </>
        ) : currentView === 'linux-patching' ? (
          <LinuxPatching />
        ) : currentView === 'live-sessions' ? (
          <LiveSessions />
        ) : currentView === 'enterprise-portal' ? (
          <EnterprisePortal theme={theme} />
        ) : currentView === 'history' ? (
          <History />
        ) : currentView === 'adhoc-execution' ? (
          <AdHocExecution />
        ) : currentView === 'patch-pipeline' ? (
          <PatchPipeline />
        ) : currentView === 'windows-patching' ? (
          <WindowsPatching />
        ) : null}
      </main>
      <Chatbot />
    </div>
  )

  const renderHome = () => (
    <div className="home-root">
      <main className="home-shell" id="home-content">
        <section className="home-hero" aria-labelledby="home-title">
          <div>
            <p className="home-kicker">NOVA Platform</p>
            <h1 id="home-title">Choose your workspace</h1>
            <p className="home-subtitle">
              Everything for Windows Server patching in one place: check readiness, deploy with one click, follow it live and share the reports.
            </p>
          </div>
        </section>

        <section className="home-tile-grid" aria-label="Available workspaces">
          {WORKSPACE_TILES.map(tile => (
            <button
              key={tile.route}
              type="button"
              className="home-tile"
              onClick={() => navigateTo(tile.route)}
              id={`tile-${tile.title.toLowerCase()}`}
            >
              <span className="home-tile-icon">
                <i className={`${tile.iconStyle || 'fa-solid'} ${tile.icon}`}></i>
              </span>
              <span className="home-tile-body">
                <span className="home-tile-title">{tile.title}</span>
                <span className="home-tile-description">{tile.description}</span>
              </span>
              <span className="home-tile-arrow">
                <i className="fa-solid fa-arrow-right"></i>
              </span>
            </button>
          ))}
        </section>
      </main>
    </div>
  )

  return (
    <div className="app-frame">
      {renderAppNav()}
      <div className="route-stage">
        {currentView ? renderUnifiedApp() : renderHome()}
      </div>
    </div>
  )
}
