/**
 * CSV for the CRM's downloads (leads CSV, ads CSV, R19 data export).
 * Cells that look like spreadsheet formulas (=, +, -, @, tab, CR at the start) get a leading
 * apostrophe, so opening an export never runs one (spreadsheet injection).
 */
function csvCell(v) {
  let s;
  if (v === null || v === undefined) s = '';
  else if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v); // jsonb columns (e.g. leads.metadata)
  else s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A whole CSV: header row from `columns`, then one row per object. `bom` adds the UTF-8 byte
 * order mark so Excel shows ₹, Arabic and Hindi correctly.
 */
function toCsv(columns, rows, { bom = false } = {}) {
  const lines = [columns.map(csvCell).join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))];
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

module.exports = { csvCell, toCsv };
