/**
 * R15: the business's currency (contract in docs/TEAM.md, "R15: currency per business").
 *
 * Amounts are stored as whole units of the business's currency in the `amount_inr` columns
 * (the name is historical: AED 950000 for a Dubai sale). This module is the one place that
 * formats and reads them, shared by the CRM (util.money) and the bot (alert texts,
 * suggestedOutcome), so src/ never depends on crm/.
 */

// prefix: what goes before the number. locale: digit grouping (Indian lakh/crore only for INR).
const CURRENCIES = {
  INR: { code: 'INR', name: 'Indian rupee', prefix: '₹', locale: 'en-IN' },
  AED: { code: 'AED', name: 'UAE dirham', prefix: 'AED ', locale: 'en-US' },
  SAR: { code: 'SAR', name: 'Saudi riyal', prefix: 'SAR ', locale: 'en-US' },
  USD: { code: 'USD', name: 'US dollar', prefix: '$', locale: 'en-US' }
};
const DEFAULT_CURRENCY = 'INR';

/** A known currency code, else INR (old profiles and bad values). */
function currencyCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return CURRENCIES[c] ? c : DEFAULT_CURRENCY;
}

/** "₹7,080", "₹9,50,000", "AED 950,000", "$950,000". Whole units; missing amounts show as 0. */
function money(amount, currency = DEFAULT_CURRENCY) {
  const c = CURRENCIES[currencyCode(currency)];
  const n = Math.round(Number(amount) || 0);
  return (n < 0 ? '-' : '') + c.prefix + Math.abs(n).toLocaleString(c.locale);
}

// Symbols and codes people type around an amount: ₹, Rs, Rs., INR, AED, Dhs, SAR, SR, USD, US$, $.
// Codes must start a word but may touch the number ("AED950000").
const AMOUNT_NOISE = /₹|\bRs\.?|\bINR|\bAED|\bDhs?\.?|\bSAR|\bSR|\bUSD|\bUS\$|\$|,|\s/gi;
const AMOUNT_ERROR = 'Enter the amount as a whole number, for example 7080.';

/**
 * Reads a typed amount: "₹7,080", "Rs 7080", "AED 950,000", "950000".
 * Returns { amount } (a whole number) or { error }. Decimals and anything else are refused,
 * because amounts are stored in whole units. Callers check their own limits.
 */
function parseAmount(text) {
  const s = String(text ?? '').replace(AMOUNT_NOISE, '');
  if (!s) return { error: AMOUNT_ERROR };
  if (/^\d+\.\d+$/.test(s)) return { error: 'Use a whole number, without paise, fils or cents.' };
  if (!/^\d{1,15}$/.test(s)) return { error: AMOUNT_ERROR };
  return { amount: Number(s) };
}

/** The settings select: [{ code, label }] in a fixed order. */
const currencyOptions = () => Object.values(CURRENCIES).map(c => ({ code: c.code, label: `${c.name} (${c.prefix.trim()})` }));

module.exports = { CURRENCIES, DEFAULT_CURRENCY, currencyCode, money, parseAmount, currencyOptions };
