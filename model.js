/* Pure YOLO label parsing/serialization: no external dependencies.
   Use directly from index.html or require('./model.js') in Node tests. */
(function (root) {
  'use strict';
  const isNumber = (s) => s.trim() !== '' && Number.isFinite(Number(s));
  const parseRow = (line) => {
    const t = line.trim().split(/\s+/);
    if (t.length === 1 && t[0] === '') return {kind: 'raw', rawLine: line};
    if (line.trim().startsWith('#')) return {kind: 'raw', rawLine: line};
    const classId = Number(t[0]);
    if (!Number.isInteger(classId) || classId < 0 || !t.slice(1).every(isNumber)) {
      return {kind: 'raw', rawLine: line, unsupported: true};
    }
    const v = t.slice(1).map(Number);
    if (t.length === 3) return {kind: 'point', classId, points: [[v[0], v[1]]], originalPoints: [[v[0], v[1]]], originalClassId: classId, rawLine: line, modified: false};
    if (t.length === 5) {
      const [cx, cy, w, h] = v;
      return {kind: 'box', classId, points: [[cx - w/2, cy - h/2], [cx + w/2, cy + h/2]], originalPoints: [[cx - w/2, cy - h/2], [cx + w/2, cy + h/2]], originalClassId: classId, rawLine: line, modified: false};
    }
    if (t.length >= 7 && t.length % 2 === 1) {
      const points = [];
      for (let i=0;i<v.length;i+=2) points.push([v[i],v[i+1]]);
      return {kind: 'polygon', classId, points, originalPoints: points.map(p => [...p]), originalClassId: classId, rawLine: line, modified: false};
    }
    return {kind: 'raw', rawLine: line, unsupported: true};
  };
  const parseLabel = (text) => {
    const ending = text.endsWith('\n');
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text === '' ? [] : text.split(/\r?\n/);
    if (ending) lines.pop();
    return {entries: lines.map(parseRow), ending, lineEnding};
  };
  const fmt = (v) => {
    const r = Math.abs(v) < 0.00000005 ? 0 : v;
    return Number(r.toFixed(8)).toString();
  };
  const serializeRow = (a) => {
    if (a.kind === 'raw' || !a.modified) return a.rawLine || '';
    if (a.rawLine && a.originalPoints && JSON.stringify(a.points) === JSON.stringify(a.originalPoints)) {
      // Class-only correction: preserve every original coordinate token and its precision.
      return a.rawLine.replace(/^(\s*)\S+/, (_m, spaces) => spaces + a.classId);
    }
    if (a.kind === 'box') {
      const [[x1,y1],[x2,y2]] = a.points;
      return [a.classId, fmt((x1+x2)/2), fmt((y1+y2)/2), fmt(x2-x1), fmt(y2-y1)].join(' ');
    }
    return [a.classId, ...a.points.flat().map(fmt)].join(' ');
  };
  const serializeLabel = (doc) => {
    const lines = doc.entries.map(serializeRow).join(doc.lineEnding);
    return lines + (doc.ending && doc.entries.length ? doc.lineEnding : '');
  };
  const validateChanged = (doc) => {
    const errors = [];
    for (const [i, a] of doc.entries.entries()) {
      if (a.kind === 'raw' || !a.modified) continue;
      if (!Number.isInteger(a.classId) || a.classId < 0) errors.push(`Row ${i+1}: invalid class`);
      if (a.kind === 'polygon' && a.points.length < 3) errors.push(`Row ${i+1}: polygon needs 3 points`);
      if (a.kind === 'box') {
        if (a.points[1][0] - a.points[0][0] <= 0 || a.points[1][1] - a.points[0][1] <= 0) errors.push(`Row ${i+1}: box has no area`);
      }
      for (const p of a.points) {
        if (p.some(v => !Number.isFinite(v) || v < 0 || v > 1)) errors.push(`Row ${i+1}: point outside normalized image (0..1)`);
      }
    }
    return errors;
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const normalizeBox = (a) => {
    if (a.kind !== 'box') return;
    const [[x1,y1],[x2,y2]] = a.points;
    a.points = [[Math.min(x1,x2),Math.min(y1,y2)],[Math.max(x1,x2),Math.max(y1,y2)]];
  };
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const api = {parseRow,parseLabel,serializeRow,serializeLabel,validateChanged,clone,normalizeBox,clamp};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCheckModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
