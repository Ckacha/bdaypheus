const fs = require('fs');
const path = require('path');

const BIRTHDAYS_FILE = path.join(__dirname, 'birthdays.json');

function loadBirthdays() {
  try {
    return JSON.parse(fs.readFileSync(BIRTHDAYS_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

let birthdays = loadBirthdays();

function save() {
  fs.writeFileSync(BIRTHDAYS_FILE, JSON.stringify(birthdays, null, 2));
}

function todayString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function getActive(birthdayUserId) {
  const record = birthdays[birthdayUserId];
  
  if (!record) return null;
  if (record.date < todayString()) {
    delete birthdays[birthdayUserId];
    save();
    return null;
  }
  
  return record;
}

function set(birthdayUserId, { date, inviterId, destChannelId, message }) {
  const existing = birthdays[birthdayUserId];
  const invites = existing && existing.inviterId === inviterId ? existing.invites || {} : {};
  birthdays[birthdayUserId] = { date, inviterId, destChannelId, message, invites, createdAt: Date.now() };
  save();
}

function statusOf(invite) {
  return typeof invite === 'string' ? invite : invite && invite.status;
}

function addInvites(birthdayUserId, sent) {
  const record = birthdays[birthdayUserId];
  if (!record) return;
  record.invites = record.invites || {};
  for (const { userId, channel, ts } of sent) {
    if (!record.invites[userId] || statusOf(record.invites[userId]) === 'pending') {
      record.invites[userId] = { status: 'pending', channel, ts };
    }
  }
  save();
}

function markResponse(birthdayUserId, userId, status) {
  const record = birthdays[birthdayUserId];
  if (!record || !record.invites || !record.invites[userId]) return;
  const invite = record.invites[userId];
  record.invites[userId] = typeof invite === 'string' ? { status } : { ...invite, status };
  save();
}

function getActiveByInviter(inviterId) {
  return Object.keys(birthdays)
    .filter((birthdayUserId) => birthdays[birthdayUserId].inviterId === inviterId)
    .map((birthdayUserId) => ({ birthdayUserId, record: getActive(birthdayUserId) }))
    .filter((entry) => entry.record);
}

module.exports = { getActive, getActiveByInviter, set, addInvites, markResponse, statusOf, todayString };
