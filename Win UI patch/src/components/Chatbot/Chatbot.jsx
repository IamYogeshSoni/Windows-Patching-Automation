import React, { useState, useEffect, useRef } from 'react'
import './Chatbot.css'

export default function Chatbot() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([
    { id: 1, text: "Hello! I am your NOVA Assistant. I can help you monitor patch compliance, generate reports, or troubleshoot failed deployments. How can I assist you today?", sender: "bot" }
  ])
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isOpen])

  const handleSend = (e) => {
    e.preventDefault()
    if (!inputValue.trim()) return

    const userMessage = { id: Date.now(), text: inputValue, sender: "user" }
    setMessages(prev => [...prev, userMessage])
    setInputValue('')

    // Simulate dummy response
    setTimeout(() => {
    let botResponse = "I'm a dummy assistant, but I can see you are running the NOVA patching suite. All systems seem nominal!"
      
      const lowerInput = userMessage.text.toLowerCase()
      if (lowerInput.includes("failed")) {
        botResponse = "I noticed 2 servers failed during the last post-check. Would you like me to pull the Windows Update event logs for them?"
      } else if (lowerInput.includes("linux")) {
        botResponse = "The Linux patching module is currently rolling out. It will support RHEL and Ubuntu architectures soon."
      } else if (lowerInput.includes("report")) {
        botResponse = "You can download the full Excel or CSV report from the Summary tab after a patching cycle."
      }

      setMessages(prev => [...prev, { id: Date.now() + 1, text: botResponse, sender: "bot" }])
    }, 1000)
  }

  return (
    <div className="chatbot-wrapper">
      {/* Chat Window */}
      <div className={`chatbot-window glass ${isOpen ? 'open' : ''}`}>
        <div className="chatbot-header">
          <div className="chatbot-header-info">
            <div className="chatbot-avatar">
              <i className="fa-solid fa-robot"></i>
            </div>
            <div>
              <h4>NOVA Assistant</h4>
              <span className="chatbot-status">Online</span>
            </div>
          </div>
          <button 
            type="button" 
            className="chatbot-close-btn" 
            onClick={() => setIsOpen(false)}
            aria-label="Close NOVA Assistant"
            title="Close Assistant"
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="chatbot-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-bubble-wrapper ${msg.sender}`}>
              <div className={`chat-bubble ${msg.sender}`}>
                {msg.text}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <form className="chatbot-input-area" onSubmit={handleSend}>
          <input 
            type="text" 
            placeholder="Ask NOVA something..." 
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          <button type="submit" disabled={!inputValue.trim()}>
            <i className="fa-solid fa-paper-plane"></i>
          </button>
        </form>
      </div>

      {/* Floating Toggle Button */}
      <button 
        className={`chatbot-toggle-btn ${isOpen ? 'hidden' : ''}`} 
        onClick={() => setIsOpen(true)}
      >
        <i className="fa-solid fa-message"></i>
      </button>
    </div>
  )
}
