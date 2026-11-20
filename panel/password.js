'use strict';
const crypto = require('crypto');

const MIN = 8, MAX = 100;

function hashPassword(pw) {
  pw = String(pw ?? '');
  if (pw.length < MIN || pw.length > MAX) throw Object.assign(new Error(`The password needs ${MIN} to ${MAX} characters (a few words together is fine).`), { status: 400 });
  const salt = crypto.randomBytes(16);
  return { s: salt.toString('hex'), h: crypto.scryptSync(pw.normalize('NFC'), salt, 64).toString('hex') };
}

function checkPassword(entry, pw) {
  if (!entry || !entry.s || !entry.h) return false;
  const want = Buffer.from(entry.h, 'hex');
  const got = crypto.scryptSync(String(pw ?? '').normalize('NFC').slice(0, 1000), Buffer.from(entry.s, 'hex'), 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { hashPassword, checkPassword, MIN, MAX };
