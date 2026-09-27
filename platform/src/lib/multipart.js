'use strict';

/**
 * The one part of a multipart/form-data body a file upload needs (the reference platform's
 * POST /data/import sends the workbook as the form field "file"). The body
 * arrives as a Buffer (express.raw); nothing is written to disk.
 */
function filePart(body, contentType, field = 'file') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = body.slice(start, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const data = body.slice(headerEnd + 4, next - 2); // the CRLF before the boundary
    const name = /name="([^"]*)"/i.exec(headers);
    if (name && name[1] === field) {
      const fn = /filename="([^"]*)"/i.exec(headers);
      return { data, fileName: fn ? fn[1] : null };
    }
    pos = next;
  }
  return null;
}

module.exports = { filePart };
