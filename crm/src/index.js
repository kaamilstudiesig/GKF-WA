/**
 * Public entry point for embedding the CRM in another Express process
 * (the WhatsApp bot app):
 *
 *   const { createCrmApp, migrateCrm } = require('./crm');
 *   await migrateCrm(db);            // after the bot's own migrations
 *   const crmApp = createCrmApp({ db });
 */
const { createCrmApp } = require('./app');
const { migrateCrm, checkBotSchema } = require('./migrations');
const { createDb } = require('./db');

module.exports = { createCrmApp, migrateCrm, checkBotSchema, createDb };
