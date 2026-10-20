import React from 'react'
import './Stepper.css'

const steps = [
  { id: 1, label: 'Server Selection', icon: 'fa-server', description: 'Select servers' },
  { id: 2, label: 'Pre-check', icon: 'fa-clipboard-check', description: 'Validate readiness' },
  { id: 3, label: 'Post-check', icon: 'fa-rotate', description: 'Apply & verify patches' },
  { id: 4, label: 'Summary', icon: 'fa-chart-column', description: 'Review results' },
]

export default function Stepper({ currentStep = 1, onStepClick }) {
  return (
    <div className="stepper-container glass" id="stepper">
      <div className="stepper">
        {steps.map((step, index) => {
          const isActive = step.id === currentStep
          const isCompleted = step.id < currentStep
          const isLast = index === steps.length - 1

          return (
            <React.Fragment key={step.id}>
              <button
                className={`stepper-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
                onClick={() => onStepClick && isCompleted && onStepClick(step.id)}
                disabled={!isCompleted && !isActive}
                id={`step-${step.id}`}
              >
                <div className="step-circle">
                  {isCompleted ? (
                    <i className="fa-solid fa-check"></i>
                  ) : (
                    <i className={`fa-solid ${step.icon}`}></i>
                  )}
                </div>
                <div className="stepper-step-info">
                  <span className="step-label">{step.label}</span>
                  <span className="step-desc">{step.description}</span>
                </div>
              </button>
              {!isLast && (
                <div className={`step-connector ${isCompleted ? 'completed' : ''}`}>
                  <div className="connector-line">
                    <div className="connector-fill"></div>
                  </div>
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}
