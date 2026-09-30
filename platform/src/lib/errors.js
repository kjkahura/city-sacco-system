'use strict';

/**
 * The error every domain function throws: a message the API returns as its
 * errorReason, and the HTTP status to answer with (400 unless said).
 */
const err = (message, status = 400) => Object.assign(new Error(message), { status });

module.exports = { err };
