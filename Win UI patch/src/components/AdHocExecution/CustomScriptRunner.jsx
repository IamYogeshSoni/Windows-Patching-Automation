import React, { useState, useEffect, useRef } from 'react';
import { APPLICATIONS_LIST, DMS_MACHINES, SCRIPT_TEMPLATES, RAW_PIPELINE_OUTPUT_TEMPLATE } from '../../data/adhocPresets';
import './CustomScriptRunner.css';

export default function CustomScriptRunner() {
  const [selectedApp, setSelectedApp] = useState(APPLICATIONS_LIST[0]);
  const [selectedMachine, setSelectedMachine] = useState(DMS_MACHINES[0].host);
  const [customMachineInput, setCustomMachineInput] = useState('');
  const [isCustomHost, setIsCustomHost] = useState(false);
  
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('playwright-e2e');
  const [scriptCode, setScriptCode] = useState(SCRIPT_TEMPLATES['playwright-e2e'].code);
  const [uploadedFileName, setUploadedFileName] = useState(null);
  
  // Terminal state
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionProgress, setExecutionProgress] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState('');
  const [copiedLog, setCopiedLog] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  
  const terminalRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-scroll terminal
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput, autoScroll]);

  // Load saved script if any
  useEffect(() => {
    const saved = localStorage.getItem(`nova-adhoc-script-${selectedTemplateKey}`);
    if (saved) {
      setScriptCode(saved);
    }
  }, [selectedTemplateKey]);

  const handleTemplateChange = (key) => {
    setSelectedTemplateKey(key);
    const template = SCRIPT_TEMPLATES[key];
    if (template) {
      const saved = localStorage.getItem(`nova-adhoc-script-${key}`);
      setScriptCode(saved || template.code);
      setUploadedFileName(null);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      if (typeof event.target?.result === 'string') {
        setScriptCode(event.target.result);
      }
    };
    reader.readAsText(file);
  };

  const handleSaveScript = () => {
    localStorage.setItem(`nova-adhoc-script-${selectedTemplateKey}`, scriptCode);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleResetScript = () => {
    const template = SCRIPT_TEMPLATES[selectedTemplateKey];
    if (template) {
      setScriptCode(template.code);
      localStorage.removeItem(`nova-adhoc-script-${selectedTemplateKey}`);
      setUploadedFileName(null);
    }
  };

  const getEffectiveHost = () => {
    return isCustomHost ? (customMachineInput.trim() || 'custom.host.ad.com') : selectedMachine;
  };

  const handleExecute = () => {
    setIsExecuting(true);
    setExecutionProgress(5);
    setTerminalOutput('');

    const targetHost = getEffectiveHost();
    const fullLog = RAW_PIPELINE_OUTPUT_TEMPLATE(selectedApp, targetHost);
    const lines = fullLog.split('\n');

    let currentLineIndex = 0;
    const intervalTime = 120; // Simulated line-by-line stream

    const timer = setInterval(() => {
      if (currentLineIndex < lines.length) {
        // Chunk a few lines for natural CLI feel
        const nextIndex = Math.min(currentLineIndex + 3, lines.length);
        const chunk = lines.slice(currentLineIndex, nextIndex).join('\n') + '\n';
        
        setTerminalOutput(prev => prev + chunk);
        currentLineIndex = nextIndex;
        setExecutionProgress(Math.min(95, Math.round((currentLineIndex / lines.length) * 100)));
      } else {
        clearInterval(timer);
        setIsExecuting(false);
        setExecutionProgress(100);
      }
    }, intervalTime);
  };

  const handleCopyLogs = () => {
    if (!terminalOutput) return;
    navigator.clipboard.writeText(terminalOutput);
    setCopiedLog(true);
    setTimeout(() => setCopiedLog(false), 3000);
  };

  const handleDownloadLog = () => {
    if (!terminalOutput) return;
    const blob = new Blob([terminalOutput], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `adhoc-run-${selectedApp.toLowerCase().replace(/\s+/g, '-')}-${getEffectiveHost()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Helper to highlight terminal elements (status tags, tables, links)
  const renderFormattedLog = () => {
    if (!terminalOutput) {
      return (
        <div className="csr-terminal-placeholder">
          <i className="fa-solid fa-terminal"></i>
          <p>Target machine execution stream will appear here in real-time.</p>
          <span>Select your Application & Host Machine above, verify your TypeScript payload, and click <strong>"Execute on Host"</strong>.</span>
        </div>
      );
    }

    const lines = terminalOutput.split('\n');
    return lines.map((line, idx) => {
      // Highlight table borders or ASCII
      if (line.startsWith('┌') || line.startsWith('├') || line.startsWith('└') || line.startsWith('│')) {
        return <div key={idx} className="csr-log-line log-table">{line}</div>;
      }
      // Highlight green pass badges
      if (line.includes('PASS') || line.includes('🟢') || line.includes('HTTP 200') || line.includes('202')) {
        return (
          <div key={idx} className="csr-log-line log-success">
            {line.includes('https://') ? (
              <span>
                {line.split('https://')[0]}
                <a
                  href={`https://${line.split('https://')[1]}`}
                  target="_blank"
                  rel="noreferrer"
                  className="csr-log-link"
                >
                  https://{line.split('https://')[1]}
                </a>
              </span>
            ) : (
              line
            )}
          </div>
        );
      }
      // Highlight command executions
      if (line.startsWith('>') || line.startsWith('$') || line.startsWith('Running') || line.startsWith('Validating')) {
        return <div key={idx} className="csr-log-line log-command">{line}</div>;
      }
      return <div key={idx} className="csr-log-line">{line}</div>;
    });
  };

  return (
    <div className="csr-root" id="custom-script-runner">
      {/* 1. Target Host & Application Configuration */}
      <section className="csr-card csr-target-section">
        <div className="csr-card-header">
          <div className="csr-card-title">
            <span className="csr-step-badge">1</span>
            <h3>Target Application & DMS Host Machine</h3>
          </div>
          <span className="csr-card-subtitle">
            Configure target enterprise scope and remote host executor node
          </span>
        </div>

        <div className="csr-controls-grid">
          {/* Application Dropdown */}
          <div className="csr-field-group">
            <label htmlFor="app-select" className="csr-label">
              <i className="fa-solid fa-cube"></i> Application Name
            </label>
            <div className="csr-select-wrapper">
              <select
                id="app-select"
                className="csr-select"
                value={selectedApp}
                onChange={(e) => setSelectedApp(e.target.value)}
              >
                {APPLICATIONS_LIST.map((app) => (
                  <option key={app} value={app}>
                    {app}
                  </option>
                ))}
              </select>
              <i className="fa-solid fa-chevron-down csr-select-arrow"></i>
            </div>
            <span className="csr-field-hint">Select the enterprise service context</span>
          </div>

          {/* DMS Machine Dropdown */}
          <div className="csr-field-group">
            <div className="csr-label-row">
              <label htmlFor="machine-select" className="csr-label">
                <i className="fa-solid fa-server"></i> DMS Host Machine
              </label>
              <button
                type="button"
                className="csr-custom-toggle-btn"
                onClick={() => setIsCustomHost(prev => !prev)}
              >
                {isCustomHost ? '← Choose from Preset List' : '+ Enter Custom Domain'}
              </button>
            </div>

            {isCustomHost ? (
              <input
                type="text"
                className="csr-input"
                placeholder="e.g. c0842.dswh.ad.com or 10.142.xx.xx"
                value={customMachineInput}
                onChange={(e) => setCustomMachineInput(e.target.value)}
              />
            ) : (
              <div className="csr-select-wrapper">
                <select
                  id="machine-select"
                  className="csr-select"
                  value={selectedMachine}
                  onChange={(e) => setSelectedMachine(e.target.value)}
                >
                  {DMS_MACHINES.map((m) => (
                    <option key={m.id} value={m.host}>
                      {m.host} ({m.env} • {m.status})
                    </option>
                  ))}
                </select>
                <i className="fa-solid fa-chevron-down csr-select-arrow"></i>
              </div>
            )}
            <span className="csr-field-hint">
              Target Executor: <strong>{getEffectiveHost()}</strong>
            </span>
          </div>
        </div>
      </section>

      {/* 2. TypeScript Script Payload & Code Editor */}
      <section className="csr-card csr-script-section">
        <div className="csr-card-header">
          <div className="csr-card-title">
            <span className="csr-step-badge">2</span>
            <h3>TypeScript Script Payload & Automation Spec</h3>
          </div>
          
          <div className="csr-script-meta-actions">
            {/* Template Selector */}
            <div className="csr-template-picker">
              <label htmlFor="template-select">Template:</label>
              <select
                id="template-select"
                className="csr-select-sm"
                value={selectedTemplateKey}
                onChange={(e) => handleTemplateChange(e.target.value)}
              >
                {Object.entries(SCRIPT_TEMPLATES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>

            {/* File Upload Trigger */}
            <input
              type="file"
              ref={fileInputRef}
              accept=".ts,.tsx,.js,.txt"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <button
              type="button"
              className="csr-btn-sm csr-btn-outline"
              onClick={() => fileInputRef.current?.click()}
              title="Upload existing .ts or .js script file"
            >
              <i className="fa-solid fa-arrow-up-from-bracket"></i>
              <span>{uploadedFileName ? uploadedFileName : 'Upload .ts Script'}</span>
            </button>
          </div>
        </div>

        {/* Code Editor Frame */}
        <div className="csr-editor-frame">
          <div className="csr-editor-topbar">
            <div className="csr-editor-file-info">
              <i className="fa-brands fa-square-js csr-ts-logo"></i>
              <span>{uploadedFileName || SCRIPT_TEMPLATES[selectedTemplateKey]?.filename || 'runner.ts'}</span>
              <span className="csr-editor-lang-pill">TypeScript (ES2022)</span>
            </div>

            <div className="csr-editor-actions">
              {savedSuccess && (
                <span className="csr-save-badge">
                  <i className="fa-solid fa-circle-check"></i> Saved!
                </span>
              )}
              <button
                type="button"
                className="csr-btn-xs csr-btn-ghost"
                onClick={handleSaveScript}
                title="Save script changes locally"
              >
                <i className="fa-regular fa-floppy-disk"></i> Save
              </button>
              <button
                type="button"
                className="csr-btn-xs csr-btn-ghost"
                onClick={handleResetScript}
                title="Reset to template default"
              >
                <i className="fa-solid fa-rotate-left"></i> Reset
              </button>
            </div>
          </div>

          <div className="csr-editor-body">
            <textarea
              className="csr-textarea"
              value={scriptCode}
              onChange={(e) => setScriptCode(e.target.value)}
              spellCheck="false"
              rows={12}
            />
          </div>
        </div>

        {/* Action Bar */}
        <div className="csr-execute-action-bar">
          <div className="csr-execute-note">
            <i className="fa-solid fa-shield-halved"></i>
            <span>
              Script compiles via <code>npx tsc --target es2022</code> and dispatches securely through Harness / NOVA Agent.
            </span>
          </div>

          <button
            type="button"
            className="csr-btn csr-btn-execute"
            onClick={handleExecute}
            disabled={isExecuting}
            id="btn-execute-on-host"
          >
            {isExecuting ? (
              <>
                <i className="fa-solid fa-circle-notch fa-spin"></i>
                <span>Executing on {getEffectiveHost()}...</span>
              </>
            ) : (
              <>
                <i className="fa-solid fa-bolt"></i>
                <span>EXECUTE ON HOST ({getEffectiveHost()})</span>
              </>
            )}
          </button>
        </div>
      </section>

      {/* 3. Realtime Terminal Output Console */}
      <section className="csr-card csr-terminal-section">
        <div className="csr-terminal-topbar">
          <div className="csr-terminal-title-group">
            <span className="csr-step-badge">3</span>
            <h3>Pipeline Terminal Output</h3>
            {isExecuting && (
              <span className="csr-live-badge">
                <span className="csr-live-dot"></span> STREAMING LIVE
              </span>
            )}
            {executionProgress === 100 && (
              <span className="csr-complete-badge">
                <i className="fa-solid fa-check"></i> EXECUTION COMPLETE
              </span>
            )}
          </div>

          <div className="csr-terminal-controls">
            <label className="csr-autoscroll-toggle">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>Auto-scroll</span>
            </label>

            <button
              type="button"
              className="csr-btn-xs csr-btn-terminal"
              onClick={handleCopyLogs}
              disabled={!terminalOutput}
            >
              <i className={`fa-solid ${copiedLog ? 'fa-check' : 'fa-copy'}`}></i>
              <span>{copiedLog ? 'Copied' : 'Copy'}</span>
            </button>

            <button
              type="button"
              className="csr-btn-xs csr-btn-terminal"
              onClick={handleDownloadLog}
              disabled={!terminalOutput}
            >
              <i className="fa-solid fa-download"></i>
              <span>Download .log</span>
            </button>

            <button
              type="button"
              className="csr-btn-xs csr-btn-terminal"
              onClick={() => { setTerminalOutput(''); setExecutionProgress(0); }}
              disabled={!terminalOutput || isExecuting}
            >
              <i className="fa-solid fa-trash-can"></i>
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        {isExecuting && (
          <div className="csr-exec-progress-track">
            <div
              className="csr-exec-progress-fill"
              style={{ width: `${executionProgress}%` }}
            ></div>
          </div>
        )}

        {/* Terminal Screen */}
        <div className="csr-terminal-screen" ref={terminalRef}>
          {renderFormattedLog()}
        </div>
      </section>
    </div>
  );
}
