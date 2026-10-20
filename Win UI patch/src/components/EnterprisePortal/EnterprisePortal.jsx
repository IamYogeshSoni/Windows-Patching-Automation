import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  fetchReadySessions,
  fetchPendingSessions,
  uploadPrecheck,
  uploadPostcheck,
  deleteLatestSession,
  fetchCompareSummary,
  fetchHostReport,
  fetchHostDrill,
  fetchComparePorts,
  fetchFailedHosts
} from '../../api/patchingApi'
import './EnterprisePortal.css'

export default function EnterprisePortal({ theme = 'light' }) {
  // Theme is now managed by App.jsx and passed as prop

  // View tabs: 'pipeline' (Active Stepper + Summary) or 'archive' (Previous Sessions)
  const [activeTab, setActiveTab] = useState('pipeline')
  const [currentTime, setCurrentTime] = useState('')

  // --- Pipeline Upload & Comparison State ---
  const [preFile, setPreFile] = useState(null)
  const [preSubmitting, setPreSubmitting] = useState(false)
  const [preSuccess, setPreSuccess] = useState(null)
  const [preErrors, setPreErrors] = useState([])
  const [preGeneralError, setPreGeneralError] = useState(null)
  const [preJustSucceeded, setPreJustSucceeded] = useState(false)
  const preInputRef = useRef(null)

  const [deletingPrevSession, setDeletingPrevSession] = useState(false)

  const [pendingChecking, setPendingChecking] = useState(false)
  const [pendingError, setPendingError] = useState(null)
  const [pendingSessions, setPendingSessions] = useState([])
  const [pendingHasTarget, setPendingHasTarget] = useState(false)
  const [pendingSessionId, setPendingSessionId] = useState(null)
  const [pendingShortCode, setPendingShortCode] = useState(null)

  const [postFile, setPostFile] = useState(null) // kept for structure, API takes sessionCode
  const [postSubmitting, setPostSubmitting] = useState(false)
  const [postSuccess, setPostSuccess] = useState(null)
  const [postErrors, setPostErrors] = useState([])
  const [postGeneralError, setPostGeneralError] = useState(null)
  const [postInfoDismissed, setPostInfoDismissed] = useState(false)

  const [readySessions, setReadySessions] = useState([])
  const [readyLoading, setReadyLoading] = useState(false)
  const [readyError, setReadyError] = useState(null)

  // --- Active Summary & Reporting State ---
  const [viewSessionId, setViewSessionId] = useState(null)
  const [viewingContext, setViewingContext] = useState(null)
  const [drilldownOpen, setDrilldownOpen] = useState(false)
  const [hasCompared, setHasCompared] = useState(false)
  
  const [compareSummary, setCompareSummary] = useState(null)
  const [compareSummaryLoading, setCompareSummaryLoading] = useState(false)
  const [compareSummaryError, setCompareSummaryError] = useState(null)

  const [failedHostsData, setFailedHostsData] = useState(null)
  const [failedHostsLoading, setFailedHostsLoading] = useState(false)
  const [failedHostsError, setFailedHostsError] = useState(null)
  const [failedModalOpen, setFailedModalOpen] = useState(false)

  // Sub-tabs in Summary reporting: 'hosts' | 'services' | 'ports' | 'failed'
  const [reportSubTab, setReportSubTab] = useState('hosts')
  const [showHostTable, setShowHostTable] = useState(false)

  // 1. Hosts list state
  const [hostReport, setHostReport] = useState([])
  const [hostReportLoading, setHostReportLoading] = useState(false)
  const [hostReportError, setHostReportError] = useState(null)
  const [hostListFilter, setHostListFilter] = useState('all') // 'all' | 'pre' | 'post' | 'diff'
  const [hostOnlyDiff, setHostOnlyDiff] = useState(false)
  const [hostPage, setHostPage] = useState(0)
  const [hostPageSize, setHostPageSize] = useState(20)
  const [hostPageMeta, setHostPageMeta] = useState({ total_hosts: 0, total_pages: 0, has_next: false, has_previous: false })
  const [hostSearchQuery, setHostSearchQuery] = useState('')

  // 2. Expanded Host Service drilldown state
  const [expandedHost, setExpandedHost] = useState(null)
  const [hostDrillRows, setHostDrillRows] = useState([])
  const [hostDrillLoading, setHostDrillLoading] = useState(false)
  const [hostDrillError, setHostDrillError] = useState(null)
  const [hostDrillPage, setHostDrillPage] = useState(0)
  const [hostDrillPageSize, setHostDrillPageSize] = useState(20)
  const [hostDrillMeta, setHostDrillMeta] = useState({ total_items: 0, total_pages: 0, has_next: false, has_previous: false })
  const [hostDrillFilter, setHostDrillFilter] = useState('diff') // 'diff' | 'pre' | 'post'

  // 3. Global Services view state
  const [globalServicesSearch, setGlobalServicesSearch] = useState('')
  const [globalServicesFilter, setGlobalServicesFilter] = useState('all') // 'all' | 'added' | 'removed' | 'modified'
  const [globalServicesPage, setGlobalServicesPage] = useState(0)
  const [globalServicesPageSize] = useState(20)

  // 4. Ports differences state
  const [portRows, setPortRows] = useState([])
  const [portLoading, setPortLoading] = useState(false)
  const [portError, setPortError] = useState(null)
  const [portPage, setPortPage] = useState(0)
  const [portPageSize, setPortPageSize] = useState(20)
  const [portMeta, setPortMeta] = useState({ total_hosts: 0, total_pages: 0, has_next: false, has_previous: false })
  const [portSearchQuery, setPortSearchQuery] = useState('')

  const [isDownloading, setIsDownloading] = useState(false)
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false)

  const summaryRef = useRef(null)
  const hostTableRef = useRef(null)

  // --- Helper calculations ---
  const ACCEPTED_TYPES = ['.csv', 'text/csv', 'application/vnd.ms-excel']
  const MAX_FILE_SIZE_MB = 25

  const preSizeMB = useMemo(() => (preFile ? (preFile.size / (1024 * 1024)).toFixed(2) : '0'), [preFile])
  const postSizeMB = useMemo(() => (postFile ? (postFile.size / (1024 * 1024)).toFixed(2) : '0'), [postFile])

  const resolveSessionId = useCallback(() => {
    return viewSessionId || pendingSessionId || preSuccess?.session_id || null
  }, [viewSessionId, pendingSessionId, preSuccess])

  const readyHasTarget = useMemo(() => {
    return !!pendingSessionId && Array.isArray(readySessions) && readySessions.some((s) => s?.session_id === pendingSessionId)
  }, [pendingSessionId, readySessions])

  const hasPendingSession = !!pendingSessionId && pendingHasTarget
  const shouldEnablePrecheck = !hasPendingSession || hasCompared
  const shouldEnablePostcheck = hasPendingSession
  const canCallReady = !!postSuccess && hasPendingSession
  const canCompare = canCallReady && readyHasTarget

  // Summary Metrics references
  const preTotal = compareSummary?.pre_check?.unique_hosts ?? null
  const postTotal = compareSummary?.post_check?.unique_hosts ?? null
  const totalDiffs = compareSummary?.hosts_summary?.hosts_with_differences ?? null
  const sameServices = compareSummary?.differences?.total_differences ?? null

  // Clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      setCurrentTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    updateTime()
    const timer = setInterval(updateTime, 1000)
    return () => clearInterval(timer)
  }, [])

  // Theme is synced by App.jsx — no local effect needed

  // Initial load
  useEffect(() => {
    checkPendingOnMount()
    fetchReadySessionsList()
  }, [])

  // --- API Integrations ---

  const checkPendingForSessionId = async (sessionIdFromPre, shortCode) => {
    setPendingChecking(true)
    setPendingError(null)
    try {
      const sessions = await fetchPendingSessions()
      setPendingSessions(sessions)
      const match = sessions.find((s) => s?.session_id === sessionIdFromPre || (shortCode && s?.short_code === shortCode)) ?? null
      if (match?.session_id) {
        setPendingHasTarget(true)
        setPendingSessionId(match.session_id)
        setPendingShortCode(match.short_code ?? null)
      } else {
        setPendingHasTarget(false)
        setPendingSessionId(null)
        setPendingShortCode(null)
      }
    } catch (err) {
      setPendingError(err.message || 'Failed to call Pending API.')
      setPendingHasTarget(false)
      setPendingSessions([])
      setPendingSessionId(null)
      setPendingShortCode(null)
    } finally {
      setPendingChecking(false)
    }
  }

  const checkPendingOnMount = async () => {
    setPendingChecking(true)
    setPendingError(null)
    try {
      const sessions = await fetchPendingSessions()
      setPendingSessions(sessions)
      if (sessions.length > 0 && sessions[0]?.session_id) {
        const chosen = sessions[0]
        setPendingHasTarget(true)
        setPendingSessionId(chosen.session_id)
        setPendingShortCode(chosen.short_code ?? null)
      } else {
        setPendingHasTarget(false)
        setPendingSessionId(null)
        setPendingShortCode(null)
      }
    } catch (err) {
      setPendingError(err.message || 'Failed to call Pending API.')
      setPendingHasTarget(false)
      setPendingSessions([])
      setPendingSessionId(null)
      setPendingShortCode(null)
    } finally {
      setPendingChecking(false)
    }
  }

  const refreshPending = async () => {
    setPendingChecking(true)
    setPendingError(null)
    try {
      const sessions = await fetchPendingSessions()
      setPendingSessions(sessions)
      if (sessions.length > 0 && sessions[0]?.session_id) {
        const chosen = sessions[0]
        setPendingHasTarget(true)
        setPendingSessionId(chosen.session_id)
        setPendingShortCode(chosen.short_code ?? null)
        return { ok: true, session: chosen }
      }
      setPendingHasTarget(false)
      setPendingSessionId(null)
      setPendingShortCode(null)
      return { ok: true, session: null }
    } catch (err) {
      const msg = err.message || 'Failed to call Pending API.'
      setPendingError(msg)
      setPendingHasTarget(false)
      setPendingSessions([])
      setPendingSessionId(null)
      setPendingShortCode(null)
      return { ok: false, session: null, error: msg }
    } finally {
      setPendingChecking(false)
    }
  }

  const fetchReadySessionsList = async () => {
    setReadyLoading(true)
    setReadyError(null)
    try {
      const sessions = await fetchReadySessions()
      setReadySessions(sessions)
    } catch (err) {
      setReadyError(err.message || 'Unable to fetch ready sessions.')
    } finally {
      setReadyLoading(false)
    }
  }

  const fetchCompareSummaryData = useCallback(async (sessionId) => {
    if (!sessionId) return
    setCompareSummaryLoading(true)
    setCompareSummaryError(null)
    try {
      const payload = await fetchCompareSummary(sessionId)
      setCompareSummary(payload)
    } catch (err) {
      setCompareSummaryError(err.message || 'Unable to load session summary.')
      setCompareSummary(null)
    } finally {
      setCompareSummaryLoading(false)
    }
  }, [])

  const fetchHostReportData = useCallback(async (sessionId, onlyDiff, pageZero, pageSize) => {
    if (!sessionId) return
    setHostReportLoading(true)
    setHostReportError(null)
    try {
      const targetPage = (pageZero ?? 0) + 1
      const payload = await fetchHostReport(sessionId, onlyDiff, targetPage, pageSize)
      setHostReport(Array.isArray(payload?.report) ? payload.report : [])
      const pg = payload?.pagination ?? {}
      setHostPageMeta({
        total_hosts: pg.total_hosts ?? payload?.total_hosts ?? 0,
        total_pages: pg.total_pages ?? 0,
        has_next: !!pg.has_next,
        has_previous: !!pg.has_previous
      })
      setHostPage((pg.page ?? 1) - 1)
      setHostPageSize(pg.page_size ?? pageSize)
    } catch (err) {
      setHostReportError(err.message || 'Unable to load host report.')
      setHostReport([])
      setHostPageMeta({ total_hosts: 0, total_pages: 0, has_next: false, has_previous: false })
    } finally {
      setHostReportLoading(false)
    }
  }, [])

  const fetchHostDrillData = useCallback(async (sessionId, hostname, pageZero, pageSize, nextFilter = 'diff') => {
    if (!sessionId || !hostname) return
    setHostDrillLoading(true)
    setHostDrillError(null)
    setExpandedHost(hostname)
    try {
      const targetPage = (pageZero ?? 0) + 1
      const payload = await fetchHostDrill(sessionId, hostname, targetPage, pageSize)
      const rows = Array.isArray(payload?.differences) ? payload.differences : (payload?.services || payload?.report || [])
      setHostDrillRows(rows)
      const pg = payload?.pagination ?? {}
      setHostDrillMeta({
        total_items: pg.total_items ?? rows.length ?? 0,
        total_pages: pg.total_pages ?? 0,
        has_next: !!pg.has_next,
        has_previous: !!pg.has_previous
      })
      setHostDrillPage((pg.page ?? 1) - 1)
      setHostDrillPageSize(pg.page_size ?? pageSize)
      setHostDrillFilter(nextFilter)
    } catch (err) {
      setHostDrillError(err.message || 'Unable to load host service details.')
      setHostDrillRows([])
      setHostDrillMeta({ total_items: 0, total_pages: 0, has_next: false, has_previous: false })
    } finally {
      setHostDrillLoading(false)
    }
  }, [])

  const fetchFailedHostsData = async (sessionId) => {
    if (!sessionId) return
    setFailedHostsLoading(true)
    setFailedHostsError(null)
    try {
      const payload = await fetchFailedHosts(sessionId)
      setFailedHostsData(payload)
    } catch (err) {
      setFailedHostsData(null)
      setFailedHostsError(err.message || 'Unable to load failed hosts data.')
    } finally {
      setFailedHostsLoading(false)
    }
  }

  const fetchPortReportData = useCallback(async (sessionId, pageZero, pageSize) => {
    if (!sessionId) return
    setPortLoading(true)
    setPortError(null)
    try {
      const targetPage = (pageZero ?? 0) + 1
      const payload = await fetchComparePorts(sessionId, targetPage, pageSize)
      setPortRows(payload?.differences ?? [])
      const pg = payload?.pagination ?? {}
      setPortMeta({
        total_hosts: pg.total_hosts ?? payload?.total_hosts ?? 0,
        total_pages: pg.total_pages ?? 0,
        has_next: !!pg.has_next,
        has_previous: !!pg.has_previous
      })
      setPortPage((pg.page ?? 1) - 1)
      setPortPageSize(pg.page_size ?? pageSize)
    } catch (err) {
      setPortError(err.message || 'Failed to load port differences.')
      setPortRows([])
    } finally {
      setPortLoading(false)
    }
  }, [])

  // --- Handlers & Actions ---

  const handlePreFileSelect = (f) => {
    resetPrecheck()
    if (!f) return setPreFile(null)
    const errs = []
    const ext = f.name.toLowerCase().substring(f.name.lastIndexOf('.'))
    if (!ACCEPTED_TYPES.includes(ext) && !ACCEPTED_TYPES.includes(f.type)) {
      errs.push('Only CSV files are allowed.')
    }
    if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      errs.push(`File exceeds ${MAX_FILE_SIZE_MB} MB limit.`)
    }
    setPreErrors(errs)
    setPreFile(errs.length ? null : f)
  }

  const handleSubmitPrecheck = async (e) => {
    e?.preventDefault()
    setPreErrors([])
    setPreGeneralError(null)
    setPreJustSucceeded(false)
    if (!preFile) {
      setPreErrors(['Please choose a CSV file before uploading.'])
      return
    }
    setPreSubmitting(true)
    try {
      const payload = await uploadPrecheck(preFile)
      setPreSuccess(payload)
      setPreJustSucceeded(true)
      const sid = payload?.session_id
      if (sid) {
        await checkPendingForSessionId(sid, payload?.short_code)
      }
    } catch (err) {
      setPreGeneralError(err.message || 'Network error occurred during Precheck upload.')
    } finally {
      setPreSubmitting(false)
    }
  }

  const handleNewPrecheck = async () => {
    if (deletingPrevSession) return
    setDeletingPrevSession(true)
    try {
      await deleteLatestSession()
      await refreshPending()
      resetPrecheck()
      setPreFile(null)
      if (preInputRef.current) preInputRef.current.value = ''
      setViewSessionId(null)
      alert('Previous Precheck session cleared. You can upload a new Precheck file now.')
    } catch (err) {
      alert(err.message || 'Unable to delete the previous session.')
    } finally {
      setDeletingPrevSession(false)
    }
  }

  const handleSubmitPostcheck = async (e) => {
    e?.preventDefault()
    setPostErrors([])
    setPostGeneralError(null)
    if (!pendingSessionId) {
      setPostErrors(['Please wait for session ID to be generated.'])
      return
    }
    if (!pendingShortCode) {
      setPostErrors(['Missing session code from Pending. Please refresh and try again.'])
      return
    }
    setPostSubmitting(true)
    try {
      const payload = await uploadPostcheck(pendingShortCode)
      setPostSuccess(payload)
      setPostInfoDismissed(false)
      setPreJustSucceeded(false)
      await fetchReadySessionsList()
    } catch (err) {
      setPostGeneralError(err.message || 'Network error occurred during Post-check analysis.')
    } finally {
      setPostSubmitting(false)
    }
  }

  const handleShowPreviousSummary = async (sessionRow) => {
    if (!sessionRow?.session_id) return
    const sid = sessionRow.session_id
    setViewSessionId(sid)
    setHasCompared(true)
    setPostInfoDismissed(true)
    setDrilldownOpen(true)
    setHostListFilter('all')
    setHostOnlyDiff(false)
    setShowHostTable(false)
    
    await Promise.all([
      fetchCompareSummaryData(sid),
      fetchHostReportData(sid, false, 0, hostPageSize),
      fetchFailedHostsData(sid),
      fetchPortReportData(sid, 0, portPageSize)
    ])

    setHostDrillRows([])
    setHostDrillError(null)
    setExpandedHost(null)
    setHostDrillFilter('diff')

    setViewingContext({
      type: 'previous',
      sessionId: sid,
      shortCode: sessionRow?.short_code || null,
      createdAt: sessionRow?.created_at || null
    })
    
    // Switch to active tab and scroll to report
    setActiveTab('pipeline')
    setTimeout(() => {
      summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 200)
  }

  const handleOpenActiveSummary = async () => {
    const { session } = await refreshPending()
    const sid = session?.session_id || resolveSessionId()
    if (!sid) {
      setCompareSummaryError('Missing session ID. Please refresh and try again.')
      return
    }
    setViewSessionId(sid)
    setViewingContext(null)
    setHasCompared(true)
    setPostInfoDismissed(true)
    setDrilldownOpen(true)
    setHostListFilter('all')
    setHostOnlyDiff(false)
    setShowHostTable(false)

    await Promise.all([
      fetchCompareSummaryData(sid),
      fetchHostReportData(sid, false, 0, hostPageSize),
      fetchFailedHostsData(sid),
      fetchPortReportData(sid, 0, portPageSize)
    ])

    setHostDrillRows([])
    setHostDrillError(null)
    setExpandedHost(null)
    setHostDrillFilter('diff')

    setTimeout(() => {
      summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 200)
  }

  const resetPrecheck = () => {
    setPreErrors([])
    setPreGeneralError(null)
    setPreJustSucceeded(false)
    setPendingError(null)
    setPendingSessions([])
    setPendingHasTarget(false)
    setPendingSessionId(null)
    setPendingShortCode(null)
    setPostErrors([])
    setPostGeneralError(null)
    setPostSuccess(null)
    setPostFile(null)
    setReadySessions([])
    setReadyError(null)
    setReadyLoading(false)
    setCompareSummary(null)
    setCompareSummaryError(null)
    setCompareSummaryLoading(false)
    setHostReport([])
    setHostReportError(null)
    setHostReportLoading(false)
    setHostPage(0)
    setHostPageMeta({ total_hosts: 0, total_pages: 0, has_next: false, has_previous: false })
    setHostDrillRows([])
    setExpandedHost(null)
    setHostDrillError(null)
    setHasCompared(false)
    setShowHostTable(false)
    setViewSessionId(null)
    setViewingContext(null)
    setFailedHostsData(null)
    setFailedHostsError(null)
    setFailedHostsLoading(false)
    setPostInfoDismissed(false)
    setPortRows([])
    setPortLoading(false)
    setPortError(null)
    setPortPage(0)
  }

  // --- Dynamic calculations/filtering for tables ---

  // Filters client report for local search query
  const filteredHostReport = useMemo(() => {
    if (!Array.isArray(hostReport)) return []
    return hostReport.filter(h => {
      const name = h?.hostname || h?.host_name || h?.host || ''
      return name.toLowerCase().includes(hostSearchQuery.toLowerCase())
    })
  }, [hostReport, hostSearchQuery])

  // Drilldown services filtering
  const filteredServiceRows = useMemo(() => {
    if (!Array.isArray(hostDrillRows)) return []
    if (hostDrillFilter === 'pre') {
      return hostDrillRows.filter(r => r?.type === 'removed' || (r?.pre_check && !r?.post_check))
    }
    if (hostDrillFilter === 'post') {
      return hostDrillRows.filter(r => r?.type === 'added' || (!r?.pre_check && r?.post_check))
    }
    return hostDrillRows
  }, [hostDrillRows, hostDrillFilter])

  // Port rows search filtering
  const filteredPortRows = useMemo(() => {
    if (!Array.isArray(portRows)) return []
    return portRows.filter(p => {
      const host = p?.hostname || ''
      const port = String(p?.local_port || '')
      const proc = p?.process_name || ''
      const query = portSearchQuery.toLowerCase()
      return host.toLowerCase().includes(query) || port.includes(query) || proc.toLowerCase().includes(query)
    })
  }, [portRows, portSearchQuery])

  // Compiled Services Global List for active session
  const globalServicesList = useMemo(() => {
    const list = []
    hostReport.forEach(h => {
      if (h.services && Array.isArray(h.services)) {
        h.services.forEach(s => {
          list.push({
            hostname: h.hostname,
            ...s
          })
        })
      }
    })
    return list.filter(s => {
      const query = globalServicesSearch.toLowerCase()
      const matchesSearch = 
        s.hostname.toLowerCase().includes(query) ||
        (s.service_name || '').toLowerCase().includes(query) ||
        (s.service_display_name || '').toLowerCase().includes(query)
      const matchesType = globalServicesFilter === 'all' || s.type === globalServicesFilter
      return matchesSearch && matchesType
    })
  }, [hostReport, globalServicesSearch, globalServicesFilter])

  const paginatedGlobalServices = useMemo(() => {
    const start = globalServicesPage * globalServicesPageSize
    return globalServicesList.slice(start, start + globalServicesPageSize)
  }, [globalServicesList, globalServicesPage, globalServicesPageSize])

  const totalGlobalServicesPages = Math.ceil(globalServicesList.length / globalServicesPageSize) || 1

  // --- Export CSV Report Builder ---
  const downloadSessionReport = async (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
      alert('No valid session selected to download. Please select a session first.')
      return
    }
    setIsDownloading(true)
    const errors = []
    let hosts = []
    let ports = []
    let failedRes = null

    try {
      // 1. Fetch complete host report
      try {
        const hostRes = await fetchHostReport(sessionId, false, 1, 1000)
        hosts = hostRes?.report || []
      } catch (err) {
        errors.push(`Hosts: ${err.message || 'Failed to fetch host report'}`)
      }

      // 2. Fetch complete port differences
      try {
        const portRes = await fetchComparePorts(sessionId, 1, 1000)
        ports = portRes?.differences || []
      } catch (err) {
        errors.push(`Ports: ${err.message || 'Failed to fetch port report'}`)
      }

      // 3. Fetch failed hosts
      try {
        failedRes = await fetchFailedHosts(sessionId)
      } catch (err) {
        // Non-critical — proceed without failed hosts section
      }

      // If ALL data fetches failed, show error and abort
      if (hosts.length === 0 && ports.length === 0 && !failedRes) {
        if (errors.length > 0) {
          alert(`Unable to download report. API errors:\n${errors.join('\n')}`)
        } else {
          alert('No data available for this session. The report cannot be generated.')
        }
        return
      }

      // CSV Construction
      const csvLines = []
      
      // Part 1: Summary Title & Hosts Summary
      csvLines.push('--- HOSTS SUMMARY ---')
      csvLines.push(['Hostname', 'Services Added', 'Services Removed', 'Services Modified', 'Total Differences'].join(','))
      if (hosts.length > 0) {
        hosts.forEach(h => {
          csvLines.push([
            h.hostname || 'Unknown',
            h.summary?.added ?? 0,
            h.summary?.removed ?? 0,
            h.summary?.modified ?? 0,
            h.summary?.total ?? 0
          ].join(','))
        })
      } else {
        csvLines.push('No host data available')
      }

      // Part 2: Services differences details
      csvLines.push('')
      csvLines.push('--- SERVICES DIFFERENCES ---')
      csvLines.push(['Hostname', 'Service Name', 'Display Name', 'Type', 'Pre Status', 'Pre Start Type', 'Post Status', 'Post Start Type'].join(','))
      hosts.forEach(h => {
        if (h.services && Array.isArray(h.services)) {
          h.services.forEach(s => {
            csvLines.push([
              h.hostname || '',
              s.service_name || '',
              `"${(s.service_display_name || '').replace(/"/g, '""')}"`,
              s.type || '',
              s.pre_check?.status || '',
              s.pre_check?.start_type || '',
              s.post_check?.status || '',
              s.post_check?.start_type || ''
            ].join(','))
          })
        }
      })

      // Part 3: Ports differences
      csvLines.push('')
      csvLines.push('--- PORTS DIFFERENCES ---')
      csvLines.push(['Hostname', 'Local Port', 'Process Name', 'Type', 'Pre State', 'Post State'].join(','))
      if (ports.length > 0) {
        ports.forEach(p => {
          csvLines.push([
            p.hostname || '',
            p.local_port || '',
            p.process_name || '',
            p.type || '',
            p.pre_check?.state || '—',
            p.post_check?.state || '—'
          ].join(','))
        })
      } else {
        csvLines.push('No port differences found')
      }

      // Part 4: Failed hosts
      if (failedRes) {
        const pre = failedRes.pre_check?.hosts || []
        const post = failedRes.post_check?.hosts || []
        const map = {}
        pre.forEach(h => { map[h] = { host: h, pre: true, post: false } })
        post.forEach(h => {
          if (map[h]) map[h].post = true
          else map[h] = { host: h, pre: false, post: true }
        })
        csvLines.push('')
        csvLines.push('--- UNREACHABLE HOSTS ---')
        csvLines.push(['Hostname', 'Pre-check Failed', 'Post-check Failed'].join(','))
        Object.values(map).forEach(item => {
          csvLines.push([item.host, item.pre ? 'Yes' : 'No', item.post ? 'Yes' : 'No'].join(','))
        })
      }

      const csvReport = csvLines.join('\n')
      const blob = new Blob(['\uFEFF' + csvReport], { type: 'text/csv;charset=utf-8' })
      const safeId = sessionId && sessionId.length >= 8 ? sessionId.substring(0, 8) : sessionId || 'unknown'
      const filename = `CDK_Patching_Report_${safeId}.csv`

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.visibility = 'hidden'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      if (errors.length > 0) {
        alert(`Report downloaded with partial data. Some sections may be missing:\n${errors.join('\n')}`)
      }

    } catch (err) {
      console.error('CSV Download Error:', err)
      alert(`Failed to generate report: ${err.message || 'Unknown error'}. Please check the console for details.`)
    } finally {
      setIsDownloading(false)
    }
  }

  // Refresh handler for Step 3
  const handleRefreshSummary = async () => {
    setIsRefreshingSummary(true)
    try {
      await Promise.all([
        refreshPending(),
        fetchReadySessionsList()
      ])
    } catch (err) {
      console.error('Refresh failed:', err)
    } finally {
      setIsRefreshingSummary(false)
    }
  }

  return (
    <div className="enterprise-portal-container animate-fade-in" data-theme={theme}>
      
      {/* Sticky Global Top Header Layout */}
      <header className="ep-header">
        <div className="ep-header-left">
          <nav className="ep-nav">
            <button 
              className={`ep-nav-btn ${activeTab === 'pipeline' ? 'active' : ''}`}
              onClick={() => setActiveTab('pipeline')}
            >
              <i className="fa-solid fa-arrows-split-up-and-left"></i> <span>Active Pipeline</span>
            </button>
            <button 
              className={`ep-nav-btn ${activeTab === 'archive' ? 'active' : ''}`}
              onClick={() => { setActiveTab('archive'); fetchReadySessionsList() }}
            >
              <i className="fa-solid fa-box-archive"></i> <span>Sessions Archive</span>
            </button>
          </nav>
        </div>

        <div className="ep-header-right">
          <div className="ep-badge syncing">
            <i className="fa-solid fa-rotate fa-spin"></i>
            <span>ServiceNow Active</span>
          </div>

          <div className="ep-badge online">
            <div className="pulse-dot"></div>
            <span>Agent Online</span>
          </div>

          <div className="ep-clock">
            <i className="fa-regular fa-clock"></i>
            <span>{currentTime || '15:58:21'}</span>
          </div>
        </div>
      </header>

      {/* Main Page Content */}
      <main className="ep-main-content">
        
        {activeTab === 'pipeline' && (
          <div className="ep-dashboard-grid">
            
            {/* Stepper Status Indicators */}
            <div className="ep-stepper-card">
              <div className="ep-stepper">
                <div className={`ep-step ${!preSuccess ? 'active' : 'completed'}`}>
                  <div className="step-circle">{preSuccess ? <i className="fa-solid fa-check"></i> : '1'}</div>
                  <div className="step-label">Upload Pre-check</div>
                </div>
                <div className={`ep-connector ${preSuccess ? 'completed' : ''}`}></div>
                <div className={`ep-step ${preSuccess && !postSuccess ? 'active' : postSuccess ? 'completed' : ''}`}>
                  <div className="step-circle">{postSuccess ? <i className="fa-solid fa-check"></i> : '2'}</div>
                  <div className="step-label">Post-check Analysis</div>
                </div>
                <div className={`ep-connector ${postSuccess ? 'completed' : ''}`}></div>
                <div className={`ep-step ${postSuccess && drilldownOpen ? 'active' : ''}`}>
                  <div className="step-circle"><i className="fa-solid fa-chart-column"></i></div>
                  <div className="step-label">View Summary</div>
                </div>
              </div>
            </div>

            {/* Stepper Cards Grid */}
            <div className="ep-stepper-grid">
              
              {/* Step 1 Card: Pre-check */}
              <div className="ep-step-card">
                <div className="ep-step-card-header">
                  <div className="step-badge">Step 1</div>
                  <h3>Pre-check Validation</h3>
                </div>
                <div className="ep-step-card-body">
                  <p className="step-description">Upload the pre-check baseline CSV to initialize a patching cycle.</p>
                  
                  {hasPendingSession ? (
                    <div className="ep-active-session-banner">
                      <i className="fa-solid fa-circle-exclamation text-warning"></i>
                      <div>
                        <strong>Active Pending Session</strong>
                        <span>ID: <code>{pendingSessionId.substring(0, 8)}...</code></span>
                        <span>Code: <code>{pendingShortCode}</code></span>
                      </div>
                      <button 
                        className="ep-btn-sm secondary" 
                        onClick={handleNewPrecheck}
                        disabled={deletingPrevSession}
                        style={{ marginLeft: 'auto', alignSelf: 'center' }}
                      >
                        {deletingPrevSession ? 'Clearing...' : 'Clear Session'}
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmitPrecheck}>
                      <div 
                        className={`ep-dropzone ${preFile ? 'has-file' : ''}`}
                        onClick={() => preInputRef.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); handlePreFileSelect(e.dataTransfer.files[0]) }}
                      >
                        <input 
                          type="file" 
                          ref={preInputRef} 
                          accept={ACCEPTED_TYPES.join(',')} 
                          style={{ display: 'none' }}
                          onChange={(e) => handlePreFileSelect(e.target.files?.[0] ?? null)}
                          disabled={!shouldEnablePrecheck}
                        />
                        {preFile ? (
                          <>
                            <i className="fa-solid fa-file-csv icon-large text-success"></i>
                            <span className="file-name">{preFile.name}</span>
                            <span className="file-size">{preSizeMB} MB</span>
                          </>
                        ) : (
                          <>
                            <i className="fa-solid fa-cloud-arrow-up icon-large text-muted"></i>
                            <span>Drag and drop CSV or <strong>click to browse</strong></span>
                            <span className="file-hint">Max 25MB</span>
                          </>
                        )}
                      </div>

                      {preErrors.length > 0 && (
                        <div className="ep-alert error">
                          {preErrors.map((err, i) => <div key={i}><i className="fa-solid fa-circle-xmark"></i> {err}</div>)}
                        </div>
                      )}
                      
                      {preGeneralError && (
                        <div className="ep-alert error">
                          <i className="fa-solid fa-circle-xmark"></i> {preGeneralError}
                        </div>
                      )}

                      {preJustSucceeded && !postSuccess && (
                        <div className="ep-alert success">
                          <i className="fa-solid fa-circle-check"></i> Precheck Baseline Uploaded.
                        </div>
                      )}

                      <button 
                        type="submit" 
                        className="ep-btn primary w-100" 
                        disabled={!shouldEnablePrecheck || preSubmitting || !preFile}
                        style={{ marginTop: 12 }}
                      >
                        {preSubmitting ? <><i className="fa-solid fa-spinner fa-spin"></i> Uploading Baseline...</> : <><i className="fa-solid fa-cloud-arrow-up"></i> Upload Baseline</>}
                      </button>
                    </form>
                  )}
                </div>
              </div>

              {/* Step 2 Card: Post-check */}
              <div className="ep-step-card">
                <div className="ep-step-card-header">
                  <div className="step-badge">Step 2</div>
                  <h3>Post-check Comparison</h3>
                </div>
                <div className="ep-step-card-body">
                  <p className="step-description">Deploy the postcheck parameters to analyze difference reports.</p>
                  
                  {postSuccess ? (
                    <div className="ep-alert success">
                      <i className="fa-solid fa-circle-check"></i> Post-check comparison completed.
                    </div>
                  ) : (
                    <div className="ep-post-actions-wrapper">
                      <div className="ep-active-session-info-box">
                        <span>Active Session ID:</span>
                        <code>{pendingSessionId ? `${pendingSessionId.substring(0, 10)}...` : 'No active session'}</code>
                        <span>Short Code:</span>
                        <code>{pendingShortCode || '—'}</code>
                      </div>

                      {postGeneralError && (
                        <div className="ep-alert error" style={{ marginTop: 12 }}>
                          <i className="fa-solid fa-circle-xmark"></i> {postGeneralError}
                        </div>
                      )}

                      <button 
                        className="ep-btn primary w-100" 
                        onClick={handleSubmitPostcheck}
                        disabled={!shouldEnablePostcheck || postSubmitting}
                        style={{ marginTop: 'auto' }}
                      >
                        {postSubmitting ? <><i className="fa-solid fa-spinner fa-spin"></i> Running Analysis...</> : <><i className="fa-solid fa-arrows-rotate"></i> Run Post-check Analysis</>}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 3 Card: Compare */}
              <div className="ep-step-card">
                <div className="ep-step-card-header">
                  <div className="step-badge">Step 3</div>
                  <h3>Retrieve Summary</h3>
                </div>
                <div className="ep-step-card-body">
                  <p className="step-description">Render the executive summary and server reports.</p>
                  
                  {!postSuccess ? (
                    <div className="ep-step-waiting-box">
                      <i className="fa-solid fa-hourglass-half text-muted"></i>
                      <span>Awaiting Step 2 completion</span>
                    </div>
                  ) : (
                    <div className="ep-comparison-actions-box">
                      {readyHasTarget ? (
                        <div className="ep-comparison-status-ready">
                          <i className="fa-solid fa-circle-check text-success"></i>
                          <span>Session comparison is ready!</span>
                        </div>
                      ) : (
                        <div className="ep-comparison-status-waiting">
                          <i className="fa-solid fa-spinner fa-spin text-info"></i>
                          <span>Verifying target readiness...</span>
                        </div>
                      )}

                      {readyError && (
                        <div className="ep-alert error">
                          <i className="fa-solid fa-circle-xmark"></i> {readyError}
                        </div>
                      )}

                      <div className="ep-step3-actions">
                        <button 
                          className="ep-btn primary" 
                          onClick={handleOpenActiveSummary}
                          disabled={!canCompare}
                          style={{ flex: 1 }}
                        >
                          Open Summary Dashboard
                        </button>
                        <button 
                          className="ep-btn secondary ep-btn-refresh" 
                          onClick={handleRefreshSummary}
                          disabled={isRefreshingSummary}
                          title="Refresh session readiness"
                        >
                          <i className={`fa-solid fa-arrows-rotate ${isRefreshingSummary ? 'fa-spin' : ''}`}></i>
                          {!isRefreshingSummary ? ' Refresh' : ' Refreshing...'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>

            {/* Reporting Drilldown view */}
            {drilldownOpen && (
              <div ref={summaryRef} className="ep-drilldown-section">
                
                {/* Active Session Context Banner */}
                {viewingContext?.type === 'previous' && (
                  <div className="ep-active-context-banner">
                    <i className="fa-solid fa-circle-info text-info"></i>
                    <div>
                      <span>Viewing historical session archive: <code>{viewingContext.sessionId}</code></span>
                      <span>Created at: {new Date(viewingContext.createdAt).toLocaleString()}</span>
                    </div>
                    <button 
                      className="ep-btn-sm primary"
                      disabled={isDownloading}
                      onClick={() => downloadSessionReport(viewingContext.sessionId)}
                      style={{ marginLeft: 'auto' }}
                    >
                      {isDownloading ? 'Downloading...' : 'Download CSV Report'}
                    </button>
                  </div>
                )}

                {/* Summary KPI Cards Row */}
                <div className="ep-kpis-wrapper">
                  <div className="ep-kpi-card clickable" onClick={() => { setShowHostTable(true); setHostOnlyDiff(false); setHostListFilter('all'); fetchHostReportData(resolveSessionId(), false, 0, hostPageSize); setTimeout(() => hostTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400) }}>
                    <div className="ep-kpi-icon total">
                      <i className="fa-solid fa-server"></i>
                    </div>
                    <div className="ep-kpi-details">
                      <span className="ep-kpi-value">{compareSummaryLoading ? '...' : (preTotal ?? '—')}</span>
                      <span className="ep-kpi-label">To Be Patched Servers</span>
                      <span className="ep-kpi-trend">Click to view all hosts</span>
                    </div>
                  </div>

                  <div className="ep-kpi-card clickable" onClick={() => { setShowHostTable(true); setHostOnlyDiff(false); setHostListFilter('post'); fetchHostReportData(resolveSessionId(), false, 0, hostPageSize); setTimeout(() => hostTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400) }}>
                    <div className="ep-kpi-icon compliance">
                      <i className="fa-solid fa-circle-check"></i>
                    </div>
                    <div className="ep-kpi-details">
                      <span className="ep-kpi-value">{compareSummaryLoading ? '...' : (postTotal ?? '—')}</span>
                      <span className="ep-kpi-label">Patched Servers</span>
                      <span className="ep-kpi-trend">Click to view patched hosts</span>
                    </div>
                  </div>

                  <div className="ep-kpi-card clickable" onClick={() => { setShowHostTable(true); setHostOnlyDiff(true); setHostListFilter('diff'); fetchHostReportData(resolveSessionId(), true, 0, hostPageSize); setTimeout(() => hostTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400) }}>
                    <div className="ep-kpi-icon critical">
                      <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <div className="ep-kpi-details">
                      <span className="ep-kpi-value">{compareSummaryLoading ? '...' : (totalDiffs ?? '—')}</span>
                      <span className="ep-kpi-label">Unhealthy Servers</span>
                      <span className="ep-kpi-trend text-danger">{(totalDiffs ?? 0) > 0 ? 'Click to show host drilldowns' : 'No differences'}</span>
                    </div>
                  </div>

                  <div className="ep-kpi-card">
                    <div className="ep-kpi-icon total" style={{ background: 'var(--ep-accent-purple-dim)', color: 'var(--ep-accent-purple)' }}>
                      <i className="fa-solid fa-arrows-spin"></i>
                    </div>
                    <div className="ep-kpi-details">
                      <span className="ep-kpi-value">{compareSummaryLoading ? '...' : (sameServices ?? '—')}</span>
                      <span className="ep-kpi-label">Services Impacted</span>
                      <span className="ep-kpi-trend">Total changes found</span>
                    </div>
                  </div>
                </div>

                {/* Failed hosts row count card */}
                <div className="ep-failed-hosts-trigger-row" style={{ marginTop: 16 }}>
                  <div className="ep-kpi-card clickable" onClick={() => { if ((failedHostsData?.failed_host_count ?? 0) > 0) setFailedModalOpen(true) }}>
                    <div className="ep-kpi-icon critical" style={{ background: 'var(--ep-danger-dim)', color: 'var(--ep-danger)' }}>
                      <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <div className="ep-kpi-details">
                      <span className="ep-kpi-value">{failedHostsLoading ? '...' : (failedHostsData?.failed_host_count ?? '—')}</span>
                      <span className="ep-kpi-label">Total Unreachable/Failed Hosts</span>
                      <span className="ep-kpi-trend">Click to open host list</span>
                    </div>
                  </div>
                </div>

                {compareSummaryError && (
                  <div className="ep-alert error" style={{ marginTop: 16 }}>
                    <i className="fa-solid fa-circle-exclamation"></i> {compareSummaryError}
                  </div>
                )}

                {/* Report Tabs navigation */}
                <div className="ep-report-tabs-bar" style={{ marginTop: 24 }}>
                  <div className="ep-tabs">
                    <button 
                      className={`ep-tab-btn ${reportSubTab === 'hosts' ? 'active' : ''}`}
                      onClick={() => setReportSubTab('hosts')}
                    >
                      <i className="fa-solid fa-server"></i> Hosts & Services
                    </button>
                    <button 
                      className={`ep-tab-btn ${reportSubTab === 'services' ? 'active' : ''}`}
                      onClick={() => setReportSubTab('services')}
                    >
                      <i className="fa-solid fa-network-wired"></i> Global Services Differences
                    </button>
                    <button 
                      className={`ep-tab-btn ${reportSubTab === 'ports' ? 'active' : ''}`}
                      onClick={() => setReportSubTab('ports')}
                    >
                      <i className="fa-solid fa-ethernet"></i> Port Differences
                    </button>
                  </div>

                  <button 
                    className="ep-btn secondary"
                    disabled={isDownloading}
                    onClick={() => downloadSessionReport(resolveSessionId())}
                  >
                    <i className="fa-solid fa-file-csv"></i> Download Full Report
                  </button>
                </div>

                {/* Tab 1: Hosts & Services */}
                {reportSubTab === 'hosts' && (
                  <div className="ep-tab-content-panel">
                    {!showHostTable ? (
                      <div className="ep-alert info">
                        <i className="fa-solid fa-circle-info"></i> Click any summary card above to open the host-wise drilldown report.
                      </div>
                    ) : (
                      <div ref={hostTableRef} className="ep-hosts-view-grid">
                        
                        {/* Filters toolbar */}
                        <div className="ep-table-toolbar">
                          <div className="ep-search-box">
                            <i className="fa-solid fa-magnifying-glass"></i>
                            <input 
                              type="text" 
                              placeholder="Search hostnames..." 
                              value={hostSearchQuery} 
                              onChange={(e) => setHostSearchQuery(e.target.value)}
                            />
                            {hostSearchQuery && <button className="clear-search" onClick={() => setHostSearchQuery('')}><i className="fa-solid fa-xmark"></i></button>}
                          </div>

                          <div className="ep-toolbar-filters">
                            <button 
                              className={`ep-filter-tab ${hostListFilter === 'all' && !hostOnlyDiff ? 'active' : ''}`}
                              onClick={() => { setHostListFilter('all'); setHostOnlyDiff(false); fetchHostReportData(resolveSessionId(), false, 0, hostPageSize) }}
                            >
                              All Hosts
                            </button>
                            <button 
                              className={`ep-filter-tab ${hostListFilter === 'pre' ? 'active' : ''}`}
                              onClick={() => { setHostListFilter('pre'); setHostOnlyDiff(false); }}
                            >
                              Pre Hosts
                            </button>
                            <button 
                              className={`ep-filter-tab ${hostListFilter === 'post' ? 'active' : ''}`}
                              onClick={() => { setHostListFilter('post'); setHostOnlyDiff(false); }}
                            >
                              Post Hosts
                            </button>
                            <button 
                              className={`ep-filter-tab ${hostListFilter === 'diff' || hostOnlyDiff ? 'active' : ''}`}
                              onClick={() => { setHostListFilter('diff'); setHostOnlyDiff(true); fetchHostReportData(resolveSessionId(), true, 0, hostPageSize) }}
                            >
                              Only differences
                            </button>
                          </div>
                        </div>

                        {/* Hosts report table */}
                        <div className="ep-table-card">
                          {hostReportLoading ? (
                            <div className="ep-skeleton-container">
                              <div className="ep-skeleton-table">
                                {[...Array(4)].map((_, i) => (
                                  <div className="skeleton-row" key={i}>
                                    <div className="skeleton-cell name"></div>
                                    <div className="skeleton-cell text"></div>
                                    <div className="skeleton-cell text"></div>
                                    <div className="skeleton-cell text"></div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="ep-table-responsive">
                              <table className="ep-table">
                                <thead>
                                  <tr>
                                    <th></th>
                                    <th>Host Name</th>
                                    <th>Pre check</th>
                                    <th>Post check</th>
                                    <th style={{ textAlign: 'center' }}>Differences</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {filteredHostReport.length === 0 ? (
                                    <tr>
                                      <td colSpan="6" className="ep-table-empty">
                                        <i className="fa-solid fa-circle-info"></i>
                                        <p>No hosts found.</p>
                                      </td>
                                    </tr>
                                  ) : (
                                    filteredHostReport.map((h) => {
                                      const isExp = expandedHost === h.hostname
                                      return (
                                        <React.Fragment key={h.hostname}>
                                          <tr 
                                            className={`ep-table-row ${isExp ? 'expanded-row' : ''} ${(h.summary?.total || 0) > 0 ? 'row-has-diff' : ''}`}
                                            onClick={() => {
                                              if (isExp) setExpandedHost(null)
                                              else fetchHostDrillData(resolveSessionId(), h.hostname, 0, hostDrillPageSize, 'diff')
                                            }}
                                          >
                                            <td className="expand-indicator-cell">
                                              <i className={`fa-solid fa-chevron-${isExp ? 'down' : 'right'} expand-icon`}></i>
                                            </td>
                                            <td className="font-semibold">{h.hostname}</td>
                                            <td>
                                              <span className="os-tag">{h?.pre_patch_count ?? h?.pre_count ?? 0} Services</span>
                                            </td>
                                            <td>
                                              <span className="os-tag">{h?.post_patch_count ?? h?.post_count ?? 0} Services</span>
                                            </td>
                                            <td style={{ textAlign: 'center' }}>
                                              {(h.summary?.total || 0) > 0 ? (
                                                <span className="patch-count-badge high">{h.summary.total} Diffs</span>
                                              ) : (
                                                <span className="patch-count-badge compliance">0 Diffs</span>
                                              )}
                                            </td>
                                            <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                              <button 
                                                className="ep-row-action-btn"
                                                onClick={() => {
                                                  if (isExp) setExpandedHost(null)
                                                  else fetchHostDrillData(resolveSessionId(), h.hostname, 0, hostDrillPageSize, 'diff')
                                                }}
                                              >
                                                {isExp ? 'Collapse' : 'Drilldown'}
                                              </button>
                                            </td>
                                          </tr>

                                          {/* Expandable Services Drilldown */}
                                          {isExp && (
                                            <tr className="ep-details-row">
                                              <td colSpan="6">
                                                <div className="ep-details-expand">
                                                  <div className="ep-details-expand-header">
                                                    <h4>Service differences for {h.hostname}</h4>
                                                    <div className="ep-filter-tabs">
                                                      <button className={`ep-filter-tab ${hostDrillFilter === 'diff' ? 'active' : ''}`} onClick={() => setHostDrillFilter('diff')}>Differences</button>
                                                      <button className={`ep-filter-tab ${hostDrillFilter === 'pre' ? 'active' : ''}`} onClick={() => setHostDrillFilter('pre')}>Pre Only</button>
                                                      <button className={`ep-filter-tab ${hostDrillFilter === 'post' ? 'active' : ''}`} onClick={() => setHostDrillFilter('post')}>Post Only</button>
                                                    </div>
                                                  </div>

                                                  {hostDrillLoading ? (
                                                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--ep-text-secondary)' }}>
                                                      <i className="fa-solid fa-spinner fa-spin"></i> Loading services...
                                                    </div>
                                                  ) : filteredServiceRows.length === 0 ? (
                                                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--ep-text-secondary)' }}>
                                                      No service differences for this filter.
                                                    </div>
                                                  ) : (
                                                    <table className="ep-sub-table">
                                                      <thead>
                                                        <tr>
                                                          <th>Service Name</th>
                                                          <th>Display Name</th>
                                                          <th>Type</th>
                                                          <th>Pre Status / StartType</th>
                                                          <th>Post Status / StartType</th>
                                                        </tr>
                                                      </thead>
                                                      <tbody>
                                                        {filteredServiceRows.map((s, idx) => (
                                                          <tr key={idx}>
                                                            <td><code>{s.service_name}</code></td>
                                                            <td>{s.service_display_name || '—'}</td>
                                                            <td>
                                                              <span className={`env-tag env-${s.type === 'added' ? 'development' : s.type === 'removed' ? 'production' : 'uat'}`}>
                                                                {s.type}
                                                              </span>
                                                            </td>
                                                            <td>{s.pre_check ? `${s.pre_check.status} (${s.pre_check.start_type || '—'})` : '—'}</td>
                                                            <td>{s.post_check ? `${s.post_check.status} (${s.post_check.start_type || '—'})` : '—'}</td>
                                                          </tr>
                                                        ))}
                                                      </tbody>
                                                    </table>
                                                  )}

                                                  {/* Drilldown pagination */}
                                                  {hostDrillMeta.total_pages > 1 && (
                                                    <div className="ep-pagination" style={{ border: 'none', padding: '10px 0 0 0' }}>
                                                      <span className="ep-pagination-left">Page {hostDrillPage + 1} of {hostDrillMeta.total_pages}</span>
                                                      <div className="ep-pagination-right">
                                                        <button className="ep-pag-btn" disabled={hostDrillPage === 0} onClick={() => fetchHostDrillData(resolveSessionId(), h.hostname, hostDrillPage - 1, hostDrillPageSize, hostDrillFilter)}><i className="fa-solid fa-chevron-left"></i> Prev</button>
                                                        <button className="ep-pag-btn" disabled={hostDrillPage >= hostDrillMeta.total_pages - 1} onClick={() => fetchHostDrillData(resolveSessionId(), h.hostname, hostDrillPage + 1, hostDrillPageSize, hostDrillFilter)}>Next <i className="fa-solid fa-chevron-right"></i></button>
                                                      </div>
                                                    </div>
                                                  )}

                                                </div>
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      )
                                    })
                                  )}
                                </tbody>
                              </table>
                            </div>
                          )}

                          {/* Pagination */}
                          {hostPageMeta.total_pages > 1 && (
                            <div className="ep-pagination">
                              <span className="ep-pagination-left">Page {hostPage + 1} of {hostPageMeta.total_pages}</span>
                              <div className="ep-pagination-right">
                                <button className="ep-pag-btn" disabled={!hostPageMeta.has_previous} onClick={() => fetchHostReportData(resolveSessionId(), hostOnlyDiff, hostPage - 1, hostPageSize)}><i className="fa-solid fa-chevron-left"></i> Prev</button>
                                <button className="ep-pag-btn" disabled={!hostPageMeta.has_next} onClick={() => fetchHostReportData(resolveSessionId(), hostOnlyDiff, hostPage + 1, hostPageSize)}>Next <i className="fa-solid fa-chevron-right"></i></button>
                              </div>
                            </div>
                          )}

                        </div>

                      </div>
                    )}
                  </div>
                )}

                {/* Tab 2: Global Services List */}
                {reportSubTab === 'services' && (
                  <div className="ep-tab-content-panel">
                    
                    {/* Filters bar */}
                    <div className="ep-table-toolbar">
                      <div className="ep-search-box">
                        <i className="fa-solid fa-magnifying-glass"></i>
                        <input 
                          type="text" 
                          placeholder="Search service name or hostname..." 
                          value={globalServicesSearch}
                          onChange={(e) => { setGlobalServicesSearch(e.target.value); setGlobalServicesPage(0) }}
                        />
                        {globalServicesSearch && <button className="clear-search" onClick={() => setGlobalServicesSearch('')}><i className="fa-solid fa-xmark"></i></button>}
                      </div>

                      <div className="ep-toolbar-filters">
                        <div className="ep-select-wrapper">
                          <span className="filter-label">Change Type:</span>
                          <select 
                            value={globalServicesFilter} 
                            onChange={(e) => { setGlobalServicesFilter(e.target.value); setGlobalServicesPage(0) }}
                            className="ep-filter-select"
                          >
                            <option value="all">All differences</option>
                            <option value="added">Added</option>
                            <option value="removed">Removed</option>
                            <option value="modified">Modified</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Global Services list table */}
                    <div className="ep-table-card">
                      <div className="ep-table-responsive">
                        <table className="ep-table">
                          <thead>
                            <tr>
                              <th>Hostname</th>
                              <th>Service Name</th>
                              <th>Display Name</th>
                              <th>Change Type</th>
                              <th>Pre Status</th>
                              <th>Pre StartType</th>
                              <th>Post Status</th>
                              <th>Post StartType</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paginatedGlobalServices.length === 0 ? (
                              <tr>
                                <td colSpan="8" className="ep-table-empty">
                                  <i className="fa-solid fa-circle-info"></i>
                                  <p>No service differences found.</p>
                                </td>
                              </tr>
                            ) : (
                              paginatedGlobalServices.map((s, i) => (
                                <tr key={i} className="ep-table-row">
                                  <td className="font-semibold">{s.hostname}</td>
                                  <td><code>{s.service_name}</code></td>
                                  <td>{s.service_display_name || '—'}</td>
                                  <td>
                                    <span className={`env-tag env-${s.type === 'added' ? 'development' : s.type === 'removed' ? 'production' : 'uat'}`}>
                                      {s.type}
                                    </span>
                                  </td>
                                  <td>{s.pre_check?.status || '—'}</td>
                                  <td><code>{s.pre_check?.start_type || '—'}</code></td>
                                  <td>{s.post_check?.status || '—'}</td>
                                  <td><code>{s.post_check?.start_type || '—'}</code></td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination */}
                      {totalGlobalServicesPages > 1 && (
                        <div className="ep-pagination">
                          <span className="ep-pagination-left">Showing {globalServicesPage * globalServicesPageSize + 1} to {Math.min((globalServicesPage + 1) * globalServicesPageSize, globalServicesList.length)} of {globalServicesList.length} differences</span>
                          <div className="ep-pagination-right">
                            <button className="ep-pag-btn" disabled={globalServicesPage === 0} onClick={() => setGlobalServicesPage(p => p - 1)}><i className="fa-solid fa-chevron-left"></i> Prev</button>
                            <button className="ep-pag-btn" disabled={globalServicesPage >= totalGlobalServicesPages - 1} onClick={() => setGlobalServicesPage(p => p + 1)}>Next <i className="fa-solid fa-chevron-right"></i></button>
                          </div>
                        </div>
                      )}

                    </div>

                  </div>
                )}

                {/* Tab 3: Port Differences */}
                {reportSubTab === 'ports' && (
                  <div className="ep-tab-content-panel">
                    
                    {/* Search filter */}
                    <div className="ep-table-toolbar">
                      <div className="ep-search-box">
                        <i className="fa-solid fa-magnifying-glass"></i>
                        <input 
                          type="text" 
                          placeholder="Search port, process, or hostname..." 
                          value={portSearchQuery}
                          onChange={(e) => setPortSearchQuery(e.target.value)}
                        />
                        {portSearchQuery && <button className="clear-search" onClick={() => setPortSearchQuery('')}><i className="fa-solid fa-xmark"></i></button>}
                      </div>
                    </div>

                    {/* Port differences table */}
                    <div className="ep-table-card">
                      {portLoading ? (
                        <div style={{ padding: 24, textAlign: 'center' }}>
                          <i className="fa-solid fa-spinner fa-spin"></i> Loading ports...
                        </div>
                      ) : (
                        <div className="ep-table-responsive">
                          <table className="ep-table">
                            <thead>
                              <tr>
                                <th>Hostname</th>
                                <th>Local Port</th>
                                <th>Process Name</th>
                                <th>Change Type</th>
                                <th>Pre State</th>
                                <th>Post State</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredPortRows.length === 0 ? (
                                <tr>
                                  <td colSpan="6" className="ep-table-empty">
                                    <i className="fa-solid fa-circle-info"></i>
                                    <p>No port differences found.</p>
                                  </td>
                                </tr>
                              ) : (
                                filteredPortRows.map((p, i) => (
                                  <tr key={i} className="ep-table-row">
                                    <td className="font-semibold">{p.hostname}</td>
                                    <td><code>{p.local_port}</code></td>
                                    <td>{p.process_name || '—'}</td>
                                    <td>
                                      <span className={`env-tag env-${p.type === 'added' ? 'development' : 'production'}`}>
                                        {p.type}
                                      </span>
                                    </td>
                                    <td>{p.pre_check?.state || '—'}</td>
                                    <td>{p.post_check?.state || '—'}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Pagination */}
                      {portMeta.total_pages > 1 && (
                        <div className="ep-pagination">
                          <span className="ep-pagination-left">Page {portPage + 1} of {portMeta.total_pages}</span>
                          <div className="ep-pagination-right">
                            <button className="ep-pag-btn" disabled={portPage === 0} onClick={() => fetchPortReportData(resolveSessionId(), portPage - 1, portPageSize)}><i className="fa-solid fa-chevron-left"></i> Prev</button>
                            <button className="ep-pag-btn" disabled={portPage >= portMeta.total_pages - 1} onClick={() => fetchPortReportData(resolveSessionId(), portPage + 1, portPageSize)}>Next <i className="fa-solid fa-chevron-right"></i></button>
                          </div>
                        </div>
                      )}

                    </div>

                  </div>
                )}

              </div>
            )}

          </div>
        )}

        {/* Sessions Archive Tab View */}
        {activeTab === 'archive' && (
          <div className="ep-archive-grid">
            <div className="ep-table-card">
              <div className="ep-card-header-simple">
                <h3>Completed Patching Sessions Archive</h3>
                <p>Browse previously successfully completed ready sessions and load their difference reports.</p>
              </div>

              {readyLoading ? (
                <div style={{ padding: 48, textAlign: 'center', color: 'var(--ep-text-secondary)' }}>
                  <i className="fa-solid fa-spinner fa-spin fa-2x"></i>
                  <p style={{ marginTop: 12 }}>Retrieving ready sessions list...</p>
                </div>
              ) : readyError ? (
                <div className="ep-alert error" style={{ margin: 20 }}>
                  <i className="fa-solid fa-circle-exclamation"></i> {readyError}
                </div>
              ) : (
                <div className="ep-table-responsive">
                  <table className="ep-table">
                    <thead>
                      <tr>
                        <th>Session ID</th>
                        <th>Short Code</th>
                        <th>Created At</th>
                        <th>Status</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {readySessions.length === 0 ? (
                        <tr>
                          <td colSpan="5" className="ep-table-empty">
                            <i className="fa-solid fa-circle-info"></i>
                            <p>No completed ready sessions found in backend DB.</p>
                          </td>
                        </tr>
                      ) : (
                        readySessions.map((row) => (
                          <tr 
                            key={row.session_id} 
                            className={`ep-table-row ${viewSessionId === row.session_id ? 'active-row' : ''}`}
                            onClick={() => handleShowPreviousSummary(row)}
                          >
                            <td><code className="session-code-text">{row.session_id}</code></td>
                            <td><code>{row.short_code || '—'}</code></td>
                            <td>{new Date(row.created_at).toLocaleString()}</td>
                            <td>
                              <span className="status-badge status-online">
                                <span className="status-dot"></span> Ready
                              </span>
                            </td>
                            <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                <button className="ep-row-action-btn" onClick={() => handleShowPreviousSummary(row)}>
                                  Load Summary
                                </button>
                                <button className="ep-row-action-btn" onClick={() => downloadSessionReport(row.session_id)}>
                                  <i className="fa-solid fa-download"></i>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {/* Failed/Unreachable Hosts Dialog Modal */}
      {failedModalOpen && createPortal(
        <div className="enterprise-portal-container ep-modal-portal-container" data-theme={theme}>
          <div className="ep-modal">
            <div className="ep-modal-header">
              <h3>Unreachable Hosts list</h3>
              <button className="ep-modal-close" onClick={() => setFailedModalOpen(false)}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="ep-modal-body">
              {failedHostsLoading ? (
                <div style={{ textAlign: 'center', padding: 20 }}>
                  <i className="fa-solid fa-spinner fa-spin"></i> Loading...
                </div>
              ) : (() => {
                const pre = Array.isArray(failedHostsData?.pre_check?.hosts) ? failedHostsData.pre_check.hosts : []
                const post = Array.isArray(failedHostsData?.post_check?.hosts) ? failedHostsData.post_check.hosts : []
                const map = new Map()
                pre.forEach((h) => { const v = map.get(h) || { host: h, pre: false, post: false }; v.pre = true; map.set(h, v) })
                post.forEach((h) => { const v = map.get(h) || { host: h, pre: false, post: false }; v.post = true; map.set(h, v) })
                const list = Array.from(map.values()).sort((a, b) => (a.host || '').localeCompare(b.host || ''))
                
                if (list.length === 0) return <div>No failed hosts found.</div>
                
                return (
                  <div className="ep-table-card" style={{ marginTop: '16px' }}>
                    <div className="ep-table-responsive" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                      <table className="ep-table">
                        <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                          <tr>
                            <th>Hostname</th>
                            <th style={{ width: '250px' }}>Failed Checks</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((item, idx) => (
                            <tr key={idx} className="ep-table-row">
                              <td className="font-semibold">{item.host}</td>
                              <td>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  {item.pre && <span className="os-tag os-tag-fail">PRE-CHECK FAIL</span>}
                                  {item.post && <span className="os-tag os-tag-fail">POST-CHECK FAIL</span>}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })()}
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn primary" onClick={() => setFailedModalOpen(false)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  )
}
