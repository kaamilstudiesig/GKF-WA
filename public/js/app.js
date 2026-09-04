/**
 * Goldkraft Fitness — WhatsApp AI Lead Assistant Demo Engine
 * Connects the mobile-first WhatsApp demo UI to the REAL GKF-WA backend AI pipeline.
 * All messages are processed by the server-side pipeline (Safety, Router, AI Service, CRM).
 */

(function () {
  'use strict';

  // Customer prompts for Auto-play Demo (streamed turn-by-turn against the live backend)
  const AUTO_PLAY_TURNS = [
    'Hi, how much is the monthly membership?',
    'I want personal training.',
    'I want to lose weight.',
    'Yes, please call me.'
  ];

  // In-memory demo lead state (synced with database)
  let currentLead = {
    name: 'Rahul Sharma',
    wa_id: 'demo_919876543210',
    display_phone: '+91 98765 43210',
    tenant_name: 'Goldkraft Fitness',
    location: 'JP Nagar, Bengaluru',
    status: 'new',
    interest: 'Personal Training',
    needs_human: false,
    handoff_reason: null,
    notes: 'None'
  };

  // State
  let messages = [];
  let isAutoPlaying = false;
  let autoPlayTimer = null;
  let isTyping = false;
  let isSending = false;
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

  // Lead Modal Dynamic Elements
  const leadCardName = document.getElementById('leadCardName');
  const leadCardPhone = document.getElementById('leadCardPhone');
  const leadCardTenant = document.getElementById('leadCardTenant');
  const leadCardLocation = document.getElementById('leadCardLocation');
  const leadCardIntent = document.getElementById('leadCardIntent');
  const leadCardStatus = document.getElementById('leadCardStatus');
  const leadCardAction = document.getElementById('leadCardAction');
  const leadCardNotes = document.getElementById('leadCardNotes');
  const leadModalStatusPill = document.getElementById('leadModalStatusPill');

  // Helper: Format current time as '10:14 AM'
  function getCurrentTimeStr(isoTimestamp) {
    const date = isoTimestamp ? new Date(isoTimestamp) : new Date();
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
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

  // Web Audio Synthetic Notification Sound (Soft pop)
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
    timeSpan.textContent = msg.time || getCurrentTimeStr(msg.timestamp);
    metaDiv.appendChild(timeSpan);

    if (msg.sender === 'customer') {
      const tickSpan = document.createElement('span');
      tickSpan.className = 'msg-status-tick';
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
  function createLeadQualifiedBadge(reason = 'Staff Follow-up Requested') {
    const badge = document.createElement('div');
    badge.className = 'system-event-badge';
    badge.innerHTML = `
      <div class="event-title-row">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        <span>Lead Qualified &bull; Human Follow-up Requested</span>
      </div>
      <div class="event-subtitle">Lead priority set to HOT &bull; Reason: ${reason}</div>
      <button type="button" class="view-lead-btn" id="inlineViewLeadBtn">
        <span>View Lead Card</span>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
          <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
        </svg>
      </button>
    `;

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

  // Append a message bubble to the chat body
  function appendMessage(msg) {
    messages.push(msg);
    const bubble = createMessageElement(msg);
    chatBody.appendChild(bubble);
    scrollToBottom();
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

  // Update Lead Card Modal Elements from Backend Lead Record
  function updateLeadModalUI(lead) {
    if (!lead) return;
    currentLead = { ...currentLead, ...lead };

    if (leadCardName) leadCardName.textContent = lead.name || 'Rahul Sharma';
    if (leadCardPhone) leadCardPhone.textContent = lead.display_phone || '+91 98765 43210';
    if (leadCardTenant) leadCardTenant.textContent = lead.tenant_name || 'Goldkraft Fitness';
    if (leadCardLocation) leadCardLocation.textContent = lead.location || 'JP Nagar, Bengaluru';
    if (leadCardIntent) leadCardIntent.textContent = lead.interest || 'Personal Training';
    if (leadCardStatus) {
      leadCardStatus.textContent = (lead.status || 'new').toUpperCase();
    }
    if (leadCardAction) {
      leadCardAction.textContent = lead.needs_human
        ? `Human Follow-up Required (${lead.handoff_reason || 'Staff Callback'})`
        : 'Automated AI Handling (No human action needed)';
    }
    if (leadCardNotes) leadCardNotes.textContent = lead.notes || 'None';

    if (leadModalStatusPill) {
      if (lead.needs_human || lead.status === 'hot') {
        leadModalStatusPill.textContent = '🔥 HOT LEAD';
        leadModalStatusPill.style.background = 'rgba(239, 68, 68, 0.2)';
        leadModalStatusPill.style.color = '#ef4444';
      } else if (lead.status === 'qualified') {
        leadModalStatusPill.textContent = '⚡ QUALIFIED';
        leadModalStatusPill.style.background = 'rgba(16, 185, 129, 0.2)';
        leadModalStatusPill.style.color = '#10b981';
      } else {
        leadModalStatusPill.textContent = (lead.status || 'NEW LEAD').toUpperCase();
        leadModalStatusPill.style.background = 'rgba(255, 255, 255, 0.1)';
        leadModalStatusPill.style.color = 'inherit';
      }
    }
  }

  // Send message to real backend AI pipeline via POST /demo/chat
  async function handleSendMessage(text) {
    const content = text || chatInput.value.trim();
    if (!content || isTyping || isSending) return;

    chatInput.value = '';
    updateSendButtonState();

    // 1. Add customer message to UI
    appendMessage({
      sender: 'customer',
      text: content,
      time: getCurrentTimeStr(),
      status: 'read'
    });
    playPopSound(true);

    // 2. Show typing indicator while real backend generates response
    showTypingIndicator();
    isSending = true;

    try {
      const response = await fetch('/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content })
      });

      const data = await response.json();
      hideTypingIndicator();

      if (data.success && data.reply) {
        appendMessage({
          sender: 'ai',
          text: data.reply,
          time: getCurrentTimeStr()
        });
        playPopSound(false);

        // If backend flagged handoff / needs_human, show qualified badge
        if (data.lead) {
          updateLeadModalUI(data.lead);
          if (data.lead.needs_human && !document.querySelector('.system-event-badge')) {
            const badge = createLeadQualifiedBadge(data.lead.handoff_reason || 'Staff Follow-up');
            chatBody.appendChild(badge);
            scrollToBottom();
          }
        }
      } else {
        appendMessage({
          sender: 'ai',
          text: data.error || 'Thanks for connecting! We are experiencing high volume. A team member will assist you shortly.',
          time: getCurrentTimeStr()
        });
      }
    } catch (err) {
      hideTypingIndicator();
      appendMessage({
        sender: 'ai',
        text: 'Our team is reviewing your inquiry and will message you back shortly. Thank you for reaching out!',
        time: getCurrentTimeStr()
      });
    } finally {
      isSending = false;
    }
  }

  // Load conversation history from backend via GET /demo/conversation
  async function loadConversationHistory() {
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

    try {
      const res = await fetch('/demo/conversation');
      const data = await res.json();

      if (data.success) {
        if (data.lead) {
          updateLeadModalUI(data.lead);
        }

        if (Array.isArray(data.messages) && data.messages.length > 0) {
          data.messages.forEach(item => {
            appendMessage({
              sender: item.sender,
              text: item.text,
              time: getCurrentTimeStr(item.timestamp)
            });
          });

          if (data.lead && data.lead.needs_human) {
            const badge = createLeadQualifiedBadge(data.lead.handoff_reason || 'Staff Follow-up');
            chatBody.appendChild(badge);
          }
        }
      }
    } catch (e) {
      // Offline / fallback silently
    }

    scrollToBottom(false);
  }

  // Auto-Play Feature: Streams real backend turns sequentially
  async function startAutoPlay() {
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

    // Clear chat and reset demo state on server first
    try {
      await fetch('/demo/reset', { method: 'POST' });
    } catch (e) {}

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

    async function stepAutoPlay() {
      if (!isAutoPlaying || step >= AUTO_PLAY_TURNS.length) {
        stopAutoPlay();
        return;
      }

      const prompt = AUTO_PLAY_TURNS[step];
      step++;

      await handleSendMessage(prompt);

      if (isAutoPlaying && step < AUTO_PLAY_TURNS.length) {
        autoPlayTimer = setTimeout(stepAutoPlay, 1800);
      } else {
        stopAutoPlay();
      }
    }

    autoPlayTimer = setTimeout(stepAutoPlay, 600);
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

  // Reset Demo: Clears demo data on server and resets UI
  async function resetDemo() {
    stopAutoPlay();
    chatInput.value = '';
    updateSendButtonState();

    try {
      const res = await fetch('/demo/reset', { method: 'POST' });
      const data = await res.json();
      if (data.lead) updateLeadModalUI(data.lead);
    } catch (e) {}

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
    scrollToBottom(false);
  }

  // Lead Modal Controls
  async function openLeadModal() {
    try {
      const res = await fetch('/demo/lead');
      const data = await res.json();
      if (data.success && data.data) {
        updateLeadModalUI(data.data);
      }
    } catch (e) {}

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
Customer: ${currentLead.name}
Phone:    ${currentLead.display_phone || currentLead.wa_id}
Gym:      ${currentLead.tenant_name || 'Goldkraft Fitness'}
Location: ${currentLead.location || 'JP Nagar, Bengaluru'}
Intent:   ${currentLead.interest || 'Personal Training'}
Status:   ${(currentLead.status || 'new').toUpperCase()}
Action:   ${currentLead.needs_human ? 'Human Follow-up Required (' + (currentLead.handoff_reason || 'Staff Callback') + ')' : 'Automated AI Handling'}
Notes:    ${currentLead.notes || 'None'}
==========================
Qualified via Goldkraft WhatsApp AI Assistant (Live Backend Pipeline)
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
    // Send message on button click
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
    loadConversationHistory();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
