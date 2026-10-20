import React, { useState, useEffect } from 'react';
import './RunValidationDialog.css';

const VALIDATION_STEPS = [
  { id: 'cdk-service', name: 'CDK Service Validation', target: 'Service & Appointments Bay', tests: '8 Playwright checks', duration: 1200 },
  { id: 'model-n-arm', name: 'Model N Retail ARM Validation', target: 'Pricing & Residual Matrices', tests: '6 Playwright checks', duration: 1200 },
  { id: 'unify', name: 'Unify Core Validation', target: 'Dealer SSO & Token Proxy', tests: '7 Playwright checks', duration: 1200 },
  { id: 'lead-crm', name: 'Lead CRM Validation', target: 'Lead Intake & Credit Flow', tests: '7 Playwright checks', duration: 1200 },
  { id: 'observability', name: 'Observability & Telemetry Sync', target: 'New Relic, Cribl & SSL Certs', tests: 'Telemetry aggregation', duration: 1200 },
  { id: 'report', name: 'Consolidated Hourly Report', target: 'Distribution & Teams Routing', tests: 'Executive batch synthesis', duration: 1200 },
];

export default function RunValidationDialog({ isOpen, onClose, onComplete }) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [stepLogs, setStepLogs] = useState([]);

  useEffect(() => {
    if (isOpen) {
      setCurrentStepIndex(0);
      setIsRunning(true);
      setIsCompleted(false);
      setStepLogs(['[INIT] Starting Ad-Hoc Validation Engine batch cycle...']);
    } else {
      setIsRunning(false);
      setIsCompleted(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isRunning || isCompleted) return;

    if (currentStepIndex < VALIDATION_STEPS.length) {
      const step = VALIDATION_STEPS[currentStepIndex];
      const timer = setTimeout(() => {
        setStepLogs(prev => [
          ...prev,
          `[PASS] Step ${currentStepIndex + 1}/${VALIDATION_STEPS.length}: ${step.name} finished successfully (${step.tests}).`,
        ]);
        if (currentStepIndex + 1 < VALIDATION_STEPS.length) {
          setCurrentStepIndex(prev => prev + 1);
        } else {
          setIsRunning(false);
          setIsCompleted(true);
          setStepLogs(prev => [
            ...prev,
            `[DONE] Batch validation completed. All telemetry signals and reports updated.`,
          ]);
        }
      }, step.duration);

      return () => clearTimeout(timer);
    }
  }, [isRunning, currentStepIndex, isCompleted]);

  if (!isOpen) return null;

  const progressPercent = Math.round(((currentStepIndex + (isCompleted ? 1 : 0)) / VALIDATION_STEPS.length) * 100);

  const handleFinish = () => {
    if (onComplete) onComplete();
    onClose();
  };

  return (
    <div className="rv-modal-backdrop" onClick={onClose}>
      <div className="rv-modal-container" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="rv-modal-header">
          <div className="rv-header-title-group">
            <div className="rv-badge-pulse">
              <span className={`rv-pulse-dot ${isRunning ? 'running' : 'complete'}`}></span>
              <span className="rv-badge-text">
                {isCompleted ? 'Validation Batch Completed' : 'Ad-Hoc Batch in Progress'}
              </span>
            </div>
            <h2>On-Demand Validation Engine</h2>
            <p className="rv-header-sub">
              Executing comprehensive synthetic tests, telemetry polling, and report compilation across all 4 enterprise core applications.
            </p>
          </div>
          <button className="rv-modal-close-btn" onClick={onClose} aria-label="Close dialog">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        {/* Progress Overview Bar */}
        <div className="rv-progress-overview">
          <div className="rv-progress-labels">
            <span>Progress ({progressPercent}%)</span>
            <span>
              {isCompleted ? '6 of 6 Complete' : `Step ${currentStepIndex + 1} of 6: ${VALIDATION_STEPS[currentStepIndex]?.name}`}
            </span>
          </div>
          <div className="rv-progress-track">
            <div
              className={`rv-progress-fill ${isCompleted ? 'success' : ''}`}
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>

        {/* Steps List */}
        <div className="rv-steps-grid">
          {VALIDATION_STEPS.map((step, idx) => {
            const isDone = idx < currentStepIndex || isCompleted;
            const isCurrent = idx === currentStepIndex && !isCompleted;
            const isPending = idx > currentStepIndex && !isCompleted;

            return (
              <div
                key={step.id}
                className={`rv-step-card ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''} ${isPending ? 'pending' : ''}`}
              >
                <div className="rv-step-icon-wrap">
                  {isDone ? (
                    <i className="fa-solid fa-circle-check rv-icon-done"></i>
                  ) : isCurrent ? (
                    <i className="fa-solid fa-circle-notch fa-spin rv-icon-spin"></i>
                  ) : (
                    <span className="rv-step-number">{idx + 1}</span>
                  )}
                </div>
                <div className="rv-step-info">
                  <div className="rv-step-title-row">
                    <span className="rv-step-title">{step.name}</span>
                    <span className={`rv-step-badge ${isDone ? 'done' : isCurrent ? 'running' : 'waiting'}`}>
                      {isDone ? 'Passed' : isCurrent ? 'Running...' : 'Queued'}
                    </span>
                  </div>
                  <div className="rv-step-meta">
                    <span><i className="fa-regular fa-folder-closed"></i> {step.target}</span>
                    <span><i className="fa-solid fa-vial-circle-check"></i> {step.tests}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Realtime Terminal Logs */}
        <div className="rv-terminal-container">
          <div className="rv-terminal-header">
            <span><i className="fa-solid fa-terminal"></i> Live Batch Execution Stream</span>
            <span className="rv-terminal-sub">UTC Timestamp Synced</span>
          </div>
          <div className="rv-terminal-body">
            {stepLogs.map((log, lIdx) => (
              <div key={lIdx} className="rv-terminal-line">
                <span className="rv-terminal-time">{new Date().toLocaleTimeString()}</span>
                <span className="rv-terminal-text">{log}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="rv-modal-footer">
          <div className="rv-footer-note">
            <i className="fa-solid fa-shield-halved"></i> All test executions are logged to the central compliance & audit ledger.
          </div>
          <div className="rv-footer-buttons">
            <button
              type="button"
              className="rv-btn rv-btn-secondary"
              onClick={onClose}
              disabled={isRunning && !isCompleted}
            >
              {isCompleted ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className="rv-btn rv-btn-primary"
              onClick={handleFinish}
              disabled={!isCompleted}
            >
              <i className="fa-solid fa-arrows-rotate"></i>
              <span>Apply & Refresh Dashboard</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
