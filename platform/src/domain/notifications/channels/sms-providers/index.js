'use strict';

/**
 * The SMS providers a SACCO can choose. No company's gateway is built in:
 * HTTP is a generic HTTPS gateway described by fields, which covers most
 * aggregators. A provider for a gateway that needs code is a module with
 * the interface in README.md, added to this list.
 */

const HTTP = require('./http');

const PROVIDERS = { HTTP };

const get = (id) => PROVIDERS[String(id || '').toUpperCase()] || null;
const ids = () => Object.keys(PROVIDERS);

/** What the settings form needs: each provider's name and fields. */
const list = () => ids().map((id) => ({ id, name: PROVIDERS[id].name, description: PROVIDERS[id].description, fields: PROVIDERS[id].fields }));

module.exports = { get, ids, list };
