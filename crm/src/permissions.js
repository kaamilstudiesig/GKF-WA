/**
 * Role rules.
 *  owner   – everything, including staff accounts and AI cost data.
 *  manager – unassigned leads plus leads of their own team; assigns within their team; reports.
 *  sales   – only leads assigned to them.
 */
const can = {
  manageUsers: u => u.role === 'owner',
  manageBusiness: u => u.role === 'owner',
  viewReports: u => u.role === 'owner' || u.role === 'manager',
  viewAiCost: u => u.role === 'owner',
  exportLeads: u => u.role === 'owner' || u.role === 'manager',
  assignLeads: u => u.role === 'owner' || u.role === 'manager',
  viewTeamFollowUps: u => u.role === 'owner' || u.role === 'manager'
};

/**
 * SQL fragment limiting rows to the leads a user may see. `q` is a Params
 * builder (src/db.js). Expects the assignment table aliased as `a`
 * (LEFT JOIN crm_lead_assignments a).
 */
function leadScope(user, q) {
  if (user.role === 'owner') return 'TRUE';
  if (user.role === 'manager') {
    const id = q.p(user.id);
    return `(a.user_id IS NULL OR a.user_id = ${id} OR a.user_id IN (SELECT id FROM crm_users WHERE manager_id = ${id}))`;
  }
  return `a.user_id = ${q.p(user.id)}`;
}

/** SQL fragment limiting staff rows (alias `u`) to people a user manages or reports on. */
function staffScope(user, q) {
  if (user.role === 'owner') return 'TRUE';
  if (user.role === 'manager') { const id = q.p(user.id); return `(u.id = ${id} OR u.manager_id = ${id})`; }
  return `u.id = ${q.p(user.id)}`;
}

/** Whether `actor` may assign a lead to `target` (a users row). */
function canAssignTo(actor, target) {
  if (!target || !target.active) return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'manager') return target.id === actor.id || target.manager_id === actor.id;
  return false;
}

module.exports = { can, leadScope, staffScope, canAssignTo };
