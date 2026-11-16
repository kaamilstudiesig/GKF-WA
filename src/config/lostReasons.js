/**
 * Why a lead was lost. Shared by the bot (AI suggestions) and the CRM (outcomes, reports).
 * The keys never change (stored outcomes, AI suggestions and Zoho use them); the wording here
 * is neutral, and each business type can reword them (lostReasons in src/config/verticals.js,
 * e.g. real estate "Bought elsewhere"). Lives under src/ so bot code does not depend on crm/.
 */
const LOST_REASONS = {
  price: 'Price too high',
  distance: 'Location',
  timing: 'Timing doesn\'t suit',
  joined_elsewhere: 'Went with someone else',
  no_response: 'Stopped replying',
  not_interested: 'Not interested',
  other: 'Other'
};

module.exports = { LOST_REASONS };
