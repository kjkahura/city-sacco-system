'use strict';

/**
 * The Excel data import, split by concern. This index rebuilds the module's
 * public API so require('./dataImport') is unchanged. The whole flow is
 * described at the top of definitions.js.
 *
 *   definitions.js  the workbook's sheets and columns, and reading a cell
 *   parse.js        reading and checking a workbook
 *   execute.js      prerequisites, and running an import (for real or as a rehearsal)
 *   workbooks.js    the template people download and the workbook of errors
 *   lifecycle.js    submitting, validating, approving and rejecting an import
 */

const definitions = require('./definitions');
const parse = require('./parse');
const execute = require('./execute');
const workbooks = require('./workbooks');
const lifecycle = require('./lifecycle');

module.exports = {
  SHEETS: definitions.SHEETS, REFERENCE_SHEETS: definitions.REFERENCE_SHEETS, parse: parse.parse, execute: execute.execute, template: workbooks.template, errorWorkbook: workbooks.errorWorkbook, prerequisites: execute.prerequisites, submit: lifecycle.submit, validate: lifecycle.validate, upload: lifecycle.upload, approve: lifecycle.approve, reject: lifecycle.reject,
  list: lifecycle.list, get: lifecycle.get, previewOf: lifecycle.previewOf, fileOf: lifecycle.fileOf, markStale: lifecycle.markStale, apiStatus: lifecycle.apiStatus, isoDate: definitions.isoDate, MAX_FILE: definitions.MAX_FILE,
};
