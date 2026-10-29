// Lead statuses as defined by the WA app's leads table CHECK constraint.
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost'];

// Handoff reasons as defined by the WA app's handoffs table.
const HANDOFF_REASONS = [
  'ready_to_book', 'price_negotiation', 'custom_program', 'injury_question',
  'human_requested', 'complaint', 'rate_limit_exceeded', 'ai_service_unavailable',
  'ai_network_error', 'budget_exceeded', 'other'
];

const ROLES = ['owner', 'manager', 'sales'];
const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', sales: 'Sales' };

// WhatsApp only allows free-form replies within 24h of the lead's last message.
const WINDOW_MS = 24 * 60 * 60 * 1000;

module.exports = { LEAD_STATUSES, HANDOFF_REASONS, ROLES, ROLE_LABELS, WINDOW_MS };
