/**
 * Goldkraft Fitness — WhatsApp AI Lead Assistant Demo Engine
 * Pure modular JavaScript handling chat state, message stream,
 * deterministic responses, typing simulation, auto-play, and lead drawer.
 */

(function () {
  'use strict';

  // --- Prepared Demo Script (Pre-populated on first load) ---
  const PREPARED_SCRIPT = [
    {
      sender: 'customer',
      text: 'Hi, how much is the monthly membership?',
      time: '10:14 AM',
      status: 'read'
    },
    {
      sender: 'ai',
      text: 'Hey! Our monthly membership starts at ₹4,040.\n\nAre you looking for regular gym access or personal training?',
      time: '10:14 AM'
    },
    {
      sender: 'customer',
      text: 'I want personal training.',
      time: '10:15 AM',
      status: 'read'
    },
    {
      sender: 'ai',
      text: 'Absolutely. We offer personal training plans based on your goals.\n\nAre you mainly looking to lose weight, build muscle, or improve overall fitness?',
      time: '10:15 AM'
    },
    {
      sender: 'customer',
      text: 'I want to lose weight.',
      time: '10:16 AM',
      status: 'read'
    },
    {
      sender: 'ai',
      text: 'Got it 👍\n\nWe can help you with a structured training plan focused on fat loss.\n\nWould you like someone from our team to contact you and help you choose the right plan?',
      time: '10:16 AM'
    },
    {
      sender: 'customer',
      text: 'Yes, please call me.',
      time: '10:17 AM',
      status: 'read'
    },
    {
      sender: 'ai',
      text: "Perfect. I've marked this as a high-priority lead for our team.\n\nSomeone from Goldkraft Fitness will get in touch with you shortly.",
      time: '10:17 AM'
    }
  ];

  // Lead Record State
  const DEMO_LEAD = {
    name: 'Rahul Sharma',
    phone: '+91 98765 43210',
    tenant: 'Goldkraft Fitness (JP Nagar)',
    intent: 'Personal Training (1-on-1)',
    goal: 'Weight Loss & Body Recomposition',
    status: 'HOT',
    priority: 'P0 — Immediate Callback',
    window: 'OPEN (23h 48m left to call)',
    action: 'Human Follow-up Required'
  };

  // State
  let messages = [];
  let isAutoPlaying = false;
  let autoPlayTimer = null;
  let isTyping = false;
  let soundEnabled = true;

  // DOM Elements
  const chatBody = document.getElementById('chatBody');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const headerStatus = document.getElementById('headerStatus');
  const autoPlayBtn = document.getElementById('autoPlayBtn');
  const resetBtn = document.getElementById('resetBtn');
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const leadModal = document.getElementById('leadModal');
  const openLeadModalBtn = document.getElementById('openLeadModalBtn');
  const closeLeadModalBtn = document.getElementById('closeLeadModalBtn');
  const copyLeadBtn = document.getElementById('copyLeadBtn');
  const quickChips = document.querySelectorAll('.prompt-chip');
  const statusBarTime = document.getElementById('statusBarTime');

  // Helper: Format current time as '10:14 AM'
  function getCurrentTimeStr() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
  }

  // Update status bar time
  function updateStatusBarTime() {
    if (statusBarTime) {
      const now = new Date();
      let hours = now.getHours();
      const minutes = now.getMinutes().toString().padStart(2, '0');
      statusBarTime.textContent = `${hours}:${minutes}`;
    }
  }

  // Web Audio Synthetic Notification Sound (Soft pop, no external files)
  function playPopSound(isOutbound = false) {
    if (!soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      if (isOutbound) {
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(850, ctx.currentTime + 0.08);
      } else {
        osc.frequency.setValueAtTime(750, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.12);
      }

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (isOutbound ? 0.08 : 0.12));

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + (isOutbound ? 0.08 : 0.12));
    } catch (e) {
      // AudioContext might be blocked until user gesture, ignore safely
    }
  }

  // Scroll Chat to Bottom
  function scrollToBottom(smooth = true) {
    chatBody.scrollTo({
      top: chatBody.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }

  // Render a Single Message Element
  function createMessageElement(msg) {
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${msg.sender === 'customer' ? 'outbound' : 'inbound'}`;

    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.textContent = msg.text;
    bubble.appendChild(textDiv);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'msg-meta';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = msg.time || getCurrentTimeStr();
    metaDiv.appendChild(timeSpan);

    if (msg.sender === 'customer') {
      const tickSpan = document.createElement('span');
      tickSpan.className = 'msg-status-tick';
      // WhatsApp double check SVG
      tickSpan.innerHTML = `
        <svg viewBox="0 0 16 15" width="16" height="15" fill="none">
          <path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.055a.426.426 0 0 0-.064-.505zm-4.35 0l-.478-.372a.365.365 0 0 0-.51.063L4.316 9.879a.32.32 0 0 1-.484.033L1.891 8.041a.366.366 0 0 0-.516.005l-.423.431a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.024-8.322a.426.426 0 0 0-.064-.505z" fill="currentColor"/>
        </svg>
      `;
      metaDiv.appendChild(tickSpan);
    }

    bubble.appendChild(metaDiv);
    return bubble;
  }

  // Render System Event Badge (Lead Qualified)
  function createLeadQualifiedBadge() {
    const badge = document.createElement('div');
    badge.className = 'system-event-badge';
    badge.innerHTML = `
      <div class="event-title-row">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        <span>Lead Qualified &bull; Human Follow-up Requested</span>
      </div>
      <div class="event-subtitle">Lead priority set to HOT &bull; 24-hour callback window active</div>
      <button type="button" class="view-lead-btn" id="inlineViewLeadBtn">
        <span>View Lead Card</span>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
          <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
        </svg>
      </button>
    `;

    // Hook inline button
    setTimeout(() => {
      const btn = badge.querySelector('#inlineViewLeadBtn');
      if (btn) btn.addEventListener('click', openLeadModal);
    }, 0);

    return badge;
  }

  // Show Typing Indicator in Chat
  function showTypingIndicator() {
    if (isTyping) return;
    isTyping = true;

    // Update Header Status Text
    if (headerStatus) {
      headerStatus.innerHTML = '<span style="color: var(--wa-accent); font-weight: 500;">typing...</span>';
    }

    const typingEl = document.createElement('div');
    typingEl.className = 'typing-bubble';
    typingEl.id = 'typingIndicator';
    typingEl.innerHTML = `
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    `;

    chatBody.appendChild(typingEl);
    scrollToBottom();
  }

  // Hide Typing Indicator
  function hideTypingIndicator() {
    isTyping = false;
    if (headerStatus) {
      headerStatus.innerHTML = '<span class="status-indicator-dot"></span> AI Assistant';
    }
    const typingEl = document.getElementById('typingIndicator');
    if (typingEl) {
      typingEl.remove();
    }
  }

  // Deterministic Response Engine for Dynamic Live Messaging
  function getDeterministicReply(userInput) {
    const text = (userInput || '').toLowerCase().trim();

    if (text.includes('membership') || text.includes('price') || text.includes('pricing') || text.includes('fee') || text.includes('cost') || text.includes('package')) {
      return 'Hey! Our monthly membership starts at ₹4,040.\n\nWe also offer Quarterly Elite (₹7,080/3mo) and Annual Pinnacle (₹14,000/yr) with full gym access. Are you looking for regular gym access or personal training?';
    }

    if (text.includes('personal training') || text.includes('trainer') || text.includes('pt') || text.includes('coach')) {
      return 'Absolutely. We offer customized personal training plans with dedicated 1-on-1 coaching and diet monitoring.\n\nAre you mainly looking to lose weight, build muscle, or improve overall fitness?';
    }

    if (text.includes('lose weight') || text.includes('weight loss') || text.includes('fat loss') || text.includes('slim') || text.includes('diet')) {
      return 'Got it 👍\n\nWe can help you with a structured training plan focused on fat loss and body recomposition.\n\nWould you like someone from our team to contact you and help you choose the right plan?';
    }

    if (text.includes('call me') || text.includes('yes') || text.includes('call') || text.includes('contact') || text.includes('phone') || text.includes('connect')) {
      return "Perfect. I've marked this as a high-priority lead for our team.\n\nSomeone from Goldkraft Fitness will get in touch with you shortly.";
    }

    if (text.includes('time') || text.includes('timing') || text.includes('hour') || text.includes('open') || text.includes('close')) {
      return 'Goldkraft Fitness is open Monday to Saturday from 6:00 AM to 10:00 PM, and Sundays from 7:00 AM to 1:00 PM. When would you like to drop by?';
    }

    if (text.includes('location') || text.includes('where') || text.includes('address') || text.includes('place')) {
      return 'We are located at 24th Main, 5th Phase, JP Nagar, Bengaluru (opposite Central Park). We have dedicated parking available for members!';
    }

    if (text.includes('trial') || text.includes('demo') || text.includes('visit') || text.includes('see')) {
      return 'We would love to invite you for a complimentary workout and facility tour! Would you like us to schedule a session for you tomorrow?';
    }

    // Generic friendly gym AI assistant response
    return 'Thanks for connecting with Goldkraft Fitness! We offer state-of-the-art strength suites, cardio equipment, and certified coaches. Would you like to know about our memberships, personal training, or schedule a free trial?';
  }

  // Send an Inbound/Outbound Message
  function appendMessage(msg) {
    messages.push(msg);
    const bubble = createMessageElement(msg);
    chatBody.appendChild(bubble);

    // If it's a handoff response, append the lead qualified badge
    if (msg.sender === 'ai' && msg.text.includes("high-priority lead")) {
      const badge = createLeadQualifiedBadge();
      chatBody.appendChild(badge);
    }

    scrollToBottom();
  }

  // Handle User Sending a Message
  function handleSendMessage(text) {
    const content = text || chatInput.value.trim();
    if (!content || isTyping) return;

    chatInput.value = '';
    updateSendButtonState();

    // 1. Add customer message
    appendMessage({
      sender: 'customer',
      text: content,
      time: getCurrentTimeStr(),
      status: 'read'
    });
    playPopSound(true);

    // 2. Simulate AI thinking with typing indicator
    showTypingIndicator();

    const delay = Math.floor(Math.random() * 400) + 850; // 850ms - 1250ms delay
    setTimeout(() => {
      hideTypingIndicator();
      const reply = getDeterministicReply(content);
      appendMessage({
        sender: 'ai',
        text: reply,
        time: getCurrentTimeStr()
      });
      playPopSound(false);
    }, delay);
  }

  // Update Send Button (Mic vs Paper Airplane)
  function updateSendButtonState() {
    const hasText = chatInput.value.trim().length > 0;
    if (hasText) {
      sendBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      `;
      sendBtn.setAttribute('title', 'Send message');
    } else {
      sendBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
        </svg>
      `;
      sendBtn.setAttribute('title', 'Voice note');
    }
  }

  // Load Prepared Script (Default View)
  function loadPreparedConversation() {
    chatBody.innerHTML = `
      <div class="chat-date-divider">TODAY</div>
      <div class="chat-security-banner">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v2h-2V7zm0 4h2v6h-2v-6z"/>
        </svg>
        <span>Messages are end-to-end encrypted. No one outside of this chat can read them.</span>
      </div>
    `;

    messages = [];
    PREPARED_SCRIPT.forEach((item) => {
      appendMessage({ ...item });
    });
  }

  // Auto-Play Feature
  function startAutoPlay() {
    if (isAutoPlaying) {
      stopAutoPlay();
      return;
    }

    isAutoPlaying = true;
    autoPlayBtn.classList.add('active');
    autoPlayBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
      </svg>
      <span>Pause Demo</span>
    `;

    // Clear chat and step through prepared conversation from scratch
    chatBody.innerHTML = `
      <div class="chat-date-divider">TODAY</div>
      <div class="chat-security-banner">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v2h-2V7zm0 4h2v6h-2v-6z"/>
        </svg>
        <span>Messages are end-to-end encrypted. No one outside of this chat can read them.</span>
      </div>
    `;
    messages = [];

    let step = 0;

    function playNextStep() {
      if (!isAutoPlaying || step >= PREPARED_SCRIPT.length) {
        stopAutoPlay();
        return;
      }

      const item = PREPARED_SCRIPT[step];
      step++;

      if (item.sender === 'ai') {
        showTypingIndicator();
        autoPlayTimer = setTimeout(() => {
          hideTypingIndicator();
          appendMessage({ ...item, time: getCurrentTimeStr() });
          playPopSound(false);
          autoPlayTimer = setTimeout(playNextStep, 1500);
        }, 1100);
      } else {
        appendMessage({ ...item, time: getCurrentTimeStr() });
        playPopSound(true);
        autoPlayTimer = setTimeout(playNextStep, 1400);
      }
    }

    autoPlayTimer = setTimeout(playNextStep, 600);
  }

  function stopAutoPlay() {
    isAutoPlaying = false;
    clearTimeout(autoPlayTimer);
    hideTypingIndicator();
    autoPlayBtn.classList.remove('active');
    autoPlayBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>
      <span>Auto-play Demo</span>
    `;
  }

  // Reset Demo
  function resetDemo() {
    stopAutoPlay();
    chatInput.value = '';
    updateSendButtonState();
    loadPreparedConversation();
    scrollToBottom(false);
  }

  // Lead Modal Controls
  function openLeadModal() {
    leadModal.classList.add('open');
  }

  function closeLeadModal() {
    leadModal.classList.remove('open');
  }

  // Copy Lead Summary
  function copyLeadDetails() {
    const text = `
GKF-WA LEAD SUMMARY
==========================
Customer: ${DEMO_LEAD.name}
Phone:    ${DEMO_LEAD.phone}
Gym:      ${DEMO_LEAD.tenant}
Intent:   ${DEMO_LEAD.intent}
Goal:     ${DEMO_LEAD.goal}
Status:   ${DEMO_LEAD.status}
Priority: ${DEMO_LEAD.priority}
Action:   ${DEMO_LEAD.action}
==========================
Qualified via Goldkraft WhatsApp AI Assistant
    `.trim();

    navigator.clipboard.writeText(text).then(() => {
      copyLeadBtn.innerHTML = `
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
        </svg>
        <span>Copied to Clipboard!</span>
      `;
      setTimeout(() => {
        copyLeadBtn.innerHTML = `
          <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
            <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/>
            <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 2H9a3 3 0 01-3-2z"/>
          </svg>
          <span>Copy Details</span>
        `;
      }, 2000);
    }).catch(() => {
      alert('Lead details copied to clipboard.');
    });
  }

  // Theme Toggle (Light / Dark)
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    if (themeToggleBtn) {
      themeToggleBtn.innerHTML = next === 'dark' 
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 01-4.4 2.26 5.403 5.403 0 01-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg><span>Dark Theme</span>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg><span>Light Theme</span>';
    }
  }

  // Event Listeners Initialization
  function initEvents() {
    // Send message on click
    sendBtn.addEventListener('click', () => {
      const text = chatInput.value.trim();
      if (text) handleSendMessage(text);
    });

    // Send on Enter
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (text) handleSendMessage(text);
      }
    });

    // Input changes (toggle mic vs send icon)
    chatInput.addEventListener('input', updateSendButtonState);

    // Quick prompt chips
    quickChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const text = chip.getAttribute('data-prompt') || chip.textContent.trim();
        handleSendMessage(text);
      });
    });

    // Demo control buttons
    if (autoPlayBtn) autoPlayBtn.addEventListener('click', startAutoPlay);
    if (resetBtn) resetBtn.addEventListener('click', resetDemo);
    if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);
    if (openLeadModalBtn) openLeadModalBtn.addEventListener('click', openLeadModal);
    if (closeLeadModalBtn) closeLeadModalBtn.addEventListener('click', closeLeadModal);
    if (copyLeadBtn) copyLeadBtn.addEventListener('click', copyLeadDetails);

    // Close modal on backdrop click
    if (leadModal) {
      leadModal.addEventListener('click', (e) => {
        if (e.target === leadModal) closeLeadModal();
      });
    }

    // Escape key closes modal
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && leadModal.classList.contains('open')) {
        closeLeadModal();
      }
    });
  }

  // Initialization
  function init() {
    updateStatusBarTime();
    setInterval(updateStatusBarTime, 60000);
    initEvents();
    loadPreparedConversation();
    scrollToBottom(false);
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
