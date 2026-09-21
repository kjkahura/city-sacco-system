'use strict';

const express = require('express');
const crypto = require('crypto');
const {
  notFound,
  badRequest,
  paginate,
  withPaginationHeaders,
  shape,
  applySort,
  applyFilterCriteria,
} = require('./http');

const newKey = () => crypto.randomBytes(12).toString('hex');

/** POST body: { filterCriteria: [...], sortingCriteria: {field, order} } */
function searchHandler(collection, { map = (r) => r } = {}) {
  return (req, res) => {
    const { filterCriteria, sortingCriteria } = req.body || {};
    let rows = applyFilterCriteria(collection.map(map), filterCriteria);
    if (sortingCriteria?.field) {
      rows = applySort(rows, `${sortingCriteria.field}:${sortingCriteria.order || 'ASC'}`);
    }
    const p = paginate(req, rows);
    withPaginationHeaders(res, p).json(shape(req, p.page));
  };
}

/**
 * Builds a Mambu-shaped router for a collection.
 *
 * Every Mambu v2 resource group exposes the same baseline contract:
 *   GET    /                 list (offset/limit/sortBy/detailsLevel)
 *   GET    /:id              get one
 *   POST   /                 create
 *   PUT    /:id              full update
 *   PATCH  /:id              partial update (JSON Patch style ops)
 *   DELETE /:id              delete
 *   POST   /:search          filter-criteria search
 *
 * Per-resource actions are added by the group module on top of this.
 */
function resourceRouter(collection, opts = {}) {
  const {
    idField = 'id',
    altIdFields = [],
    validate = null,
    onCreate = null,
    map = (r) => r,
    immutable = false, // financial records: no PUT/DELETE, adjust instead
  } = opts;

  const router = express.Router();

  const findIdx = (id) =>
    collection.findIndex(
      (r) => String(r?.[idField]) === String(id) || altIdFields.some((f) => String(r?.[f]) === String(id))
    );

  router.get('/', (req, res) => {
    let rows = collection.map(map);
    rows = applySort(rows, req.query.sortBy);
    const p = paginate(req, rows);
    withPaginationHeaders(res, p).json(shape(req, p.page));
  });

  // Mambu spells search as POST /resource:search. A colon suffix never matches
  // a sub-router mount, so the handler is also exported and registered by the
  // parent router at the full path.
  router.post('/search', searchHandler(collection, { map }));

  router.get('/:id', (req, res) => {
    const i = findIdx(req.params.id);
    if (i === -1) return notFound(res, opts.name || 'resource');
    res.json(shape(req, map(collection[i])));
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (validate) {
      const err = validate(body);
      if (err) return badRequest(res, err);
    }
    const row = {
      [idField]: body[idField] || newKey(),
      encodedKey: newKey(),
      creationDate: new Date().toISOString(),
      lastModifiedDate: new Date().toISOString(),
      ...body,
    };
    if (onCreate) onCreate(row, body);
    collection.unshift(row);
    res.status(201).json(map(row));
  });

  if (!immutable) {
    router.put('/:id', (req, res) => {
      const i = findIdx(req.params.id);
      if (i === -1) return notFound(res, opts.name || 'resource');
      collection[i] = {
        ...collection[i],
        ...req.body,
        [idField]: collection[i][idField],
        encodedKey: collection[i].encodedKey,
        lastModifiedDate: new Date().toISOString(),
      };
      res.json(map(collection[i]));
    });

    // Mambu PATCH takes an array of {op, path, value}
    router.patch('/:id', (req, res) => {
      const i = findIdx(req.params.id);
      if (i === -1) return notFound(res, opts.name || 'resource');
      const ops = Array.isArray(req.body) ? req.body : [];
      for (const { op, path, value } of ops) {
        const field = String(path || '').replace(/^\//, '');
        if (!field) continue;
        if (op === 'REMOVE') delete collection[i][field];
        else collection[i][field] = value;
      }
      collection[i].lastModifiedDate = new Date().toISOString();
      res.status(204).end();
    });

    router.delete('/:id', (req, res) => {
      const i = findIdx(req.params.id);
      if (i === -1) return notFound(res, opts.name || 'resource');
      collection.splice(i, 1);
      res.status(204).end();
    });
  }

  router._findIdx = findIdx;
  return router;
}

module.exports = { resourceRouter, newKey, searchHandler };
