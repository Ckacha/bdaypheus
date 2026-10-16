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

// keeps earlier invites if the same inviter sends more
function set(birthdayUserId, { date, inviterId, destChannelId, message }) {
  const existing = birthdays[birthdayUserId];
  const invites = existing && existing.inviterId === inviterId ? existing.invites || {} : {};
  birthdays[birthdayUserId] = { date, inviterId, destChannelId, message, invites, createdAt: Date.now() };
  save();
}

function addInvites(birthdayUserId, userIds) {
  const record = birthdays[birthdayUserId];
  if (!record) return;
  record.invites = record.invites || {};
  for (const userId of userIds) {
    if (!record.invites[userId]) record.invites[userId] = 'pending';
  }
  save();
}

function markResponse(birthdayUserId, userId, status) {
  const record = birthdays[birthdayUserId];
  if (!record || !record.invites || !record.invites[userId]) return;
  record.invites[userId] = status;
  save();
}

function getActiveByInviter(inviterId) {
  return Object.keys(birthdays)
    .filter((birthdayUserId) => birthdays[birthdayUserId].inviterId === inviterId)
    .map((birthdayUserId) => ({ birthdayUserId, record: getActive(birthdayUserId) }))
    .filter((entry) => entry.record);
}

module.exports = { getActive, getActiveByInviter, set, addInvites, markResponse, todayString };
