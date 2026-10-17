require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { App, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const tokenStore = require('./tokenStore');
const birthdayStore = require('./birthdayStore');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

const OAUTH_PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; 
const SLACK_OAUTH_REDIRECT_URI = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/slack/oauth/callback` : null;
const HACKCLUB_OAUTH_REDIRECT_URI = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/oauth/callback` : null;

const HACKCLUB_AUTH_BASE = 'https://auth.hackclub.com';
const HACKCLUB_SCOPE = 'openid profile';
const PENDING_CONNECTION_TTL_MS = 15 * 60 * 1000;

const CHAIN_ENABLED = Boolean(
  PUBLIC_BASE_URL &&
    process.env.SLACK_CLIENT_ID &&
    process.env.SLACK_CLIENT_SECRET &&
    process.env.HACKCLUB_CLIENT_ID &&
    process.env.HACKCLUB_CLIENT_SECRET
);

const ADMIN_SLACK_USER_ID = process.env.ADMIN_SLACK_USER_ID;

const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);
let BOT_USER_ID = null;

function errorDetail(err) {
  return (err && err.data && err.data.error) || (err && err.message) || String(err);
}

async function notifyAdmin(label, slackUserId, detail) {
  if (!ADMIN_SLACK_USER_ID) return;
  try {
    await botClient.chat.postMessage({
      channel: ADMIN_SLACK_USER_ID,
      text: `:rotating_light: ${label}${slackUserId ? ` (from <@${slackUserId}>)` : ''}: ${detail}`,
    });

  } catch (e) {
  }
}

async function reportError(slackUserId, label, err) {
  const detail = errorDetail(err);
  const adminMention = ADMIN_SLACK_USER_ID ? `<@${ADMIN_SLACK_USER_ID}>` : 'the bot admin';

  if (slackUserId) {
    try {
      await botClient.chat.postMessage({
        channel: slackUserId,
        text: `:warning: ${label}: ${detail}\nIf this keeps happening, contact ${adminMention}.`,
      });
    } catch (e) {
    }
  }

  await notifyAdmin(label, slackUserId, detail);

  return detail;
}

const README_URL = 'https://github.com/CKacha/bday-bot#readme';

const CONSENT_WARNING =
  ':exclamation: *Small fyi:* by going through auth the bot will be using your slack user token to only read the members of ' +
  'private channels you are a part of, and to create private planning channels for you when you ask it to. ' +
  'Read the full info in <https://github.com/CKacha/bday-bot/blob/main/docs/warning.md|the warning file>. ' +
  'You can revoke the token at any time by running /unlink-bdaypheus ';

const pendingConnections = new Map();

function buildConnectUrl(inviterId) {
  if (!CHAIN_ENABLED) return null;
  return `${PUBLIC_BASE_URL}/connect/start?slack_user=${encodeURIComponent(inviterId)}`;
}

function slackAuthorizeUrl(state) {
  return (
    `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}` +
    `&user_scope=groups:read,channels:read,groups:write` +
    `&redirect_uri=${encodeURIComponent(SLACK_OAUTH_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

function hackclubAuthorizeUrl(state) {
  return (
    `${HACKCLUB_AUTH_BASE}/oauth/authorize?client_id=${process.env.HACKCLUB_CLIENT_ID}` +
    `&response_type=code&scope=${encodeURIComponent(HACKCLUB_SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(HACKCLUB_OAUTH_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

function getPendingConnection(state) {
  const pending = pendingConnections.get(state);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_CONNECTION_TTL_MS) {
    pendingConnections.delete(state);
    return null;
  }
  return pending;
}

function getUserClient(userId) {
  const token = tokenStore.get(userId) || process.env.SLACK_USER_TOKEN;
  return token ? new WebClient(token) : null;
}

async function fetchChannelContext(botClient, inviterId, channelId) {
  const userClient = getUserClient(inviterId);
  const reader = userClient || botClient;
  try {
    const info = await reader.conversations.info({ channel: channelId });
    const members = await getChannelMembers(reader, channelId);
    return { info, members };
  } catch (err) {
    
    const code = err.data ? err.data.error : err.message;
    const missingAccess = ['channel_not_found', 'not_in_channel', 'missing_scope'].includes(code);
    if (!userClient && CHAIN_ENABLED && missingAccess) {
      const needsConnectErr = new Error('needs_connect');
      needsConnectErr.needsConnect = true;
      throw needsConnectErr;
    }

    throw err;

  }
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(`<html><body>${body}</body></html>`);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);

    if (url.pathname === '/connect/start') {
      const slackUserId = url.searchParams.get('slack_user');
      if (!slackUserId) {
        sendHtml(res, 400, 'Missing slack_user.');
        return;
      }
      const state = crypto.randomUUID();
      pendingConnections.set(state, { slackUserId, hackclubVerified: false, createdAt: Date.now() });
      res.writeHead(302, { Location: hackclubAuthorizeUrl(state) });
      res.end();
      return;
    }

    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const pending = state && getPendingConnection(state);
      if (!code || !pending) {
        sendHtml(res, 400, 'This connection link expired or is invalid. Use /link-bdaypheus to start again.');
        return;
      }

      try {
        const tokenResp = await fetch(`${HACKCLUB_AUTH_BASE}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.HACKCLUB_CLIENT_ID,
            client_secret: process.env.HACKCLUB_CLIENT_SECRET,
            redirect_uri: HACKCLUB_OAUTH_REDIRECT_URI,
            code,
            grant_type: 'authorization_code',
          }),
        });
        const tokenData = await tokenResp.json();
        if (!tokenResp.ok || !tokenData.access_token) {
          sendHtml(res, 400, "Hack Club Auth didn't confirm your identity. Please try again.");
          await reportError(pending.slackUserId, 'Hack Club Auth connect failed', new Error('did not confirm identity'));
          return;
        }

        pending.hackclubVerified = true;
        res.writeHead(302, { Location: slackAuthorizeUrl(state) });
        res.end();
      } catch (err) {
        sendHtml(res, 500, 'Something went wrong verifying your Hack Club account.');
        await reportError(pending.slackUserId, 'Hack Club Auth token exchange threw', err);
      }
      return;
    }

    if (url.pathname === '/slack/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const pending = state && getPendingConnection(state);

      if (!code) {
        sendHtml(res, 400, 'Missing code.');
        return;
      }
      if (CHAIN_ENABLED && (!pending || !pending.hackclubVerified)) {
        sendHtml(res, 400, 'Hack Club verification is required first. Use /link-bdaypheus to start again.');
        return;
      }

      try {
        const result = await new WebClient().oauth.v2.access({
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: SLACK_OAUTH_REDIRECT_URI,
        });
        const userId = result.authed_user && result.authed_user.id;
        const userToken = result.authed_user && result.authed_user.access_token;
        if (!userId || !userToken) {
          sendHtml(res, 400, "Slack didn't return a user token. If this is a localhost version, amke sure the bot has user scopes enabled.");
          await reportError(
            pending && pending.slackUserId,
            'Slack connect failed',
            new Error('Slack did not return a user token')
          );
          return;
        }
        tokenStore.set(userId, userToken);
        await notifyAdmin('Personal Slack token added', userId, 'user linked their account via /link-bdaypheus');
        if (state) pendingConnections.delete(state);
        sendHtml(
          res,
          200,
          'Connected! You can close this tab and go back to Slack. If you had the /bdaypheus form open, close it and run /bdaypheus again.'
        );
      } catch (err) {
        sendHtml(res, 500, 'Something went wrong connecting your account.');
        await reportError(pending && pending.slackUserId, 'Slack token exchange threw', err);
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');

  })

  .listen(OAUTH_PORT, () => {
    console.log(`OAuth callback server listening on port ${OAUTH_PORT}`);
  });

async function getChannelMembers(client, channelId) {
  const members = [];
  let cursor;
  do {
    const resp = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
    members.push(...resp.members);
    cursor = resp.response_metadata && resp.response_metadata.next_cursor;
  } while (cursor);
  return members;
}

async function getBotUserIds(client, userIds) {
  const botIds = new Set(['USLACKBOT']);
  for (const userId of userIds) {
    if (botIds.has(userId)) continue;
    try {
      const resp = await client.users.info({ user: userId });
      if (resp.user && resp.user.is_bot) botIds.add(userId);
    } catch (err) {
    }
  }
  return botIds;
}

const MAX_USERGROUP_SUGGESTIONS = 100;
const USERGROUP_CACHE_TTL_MS = 60 * 1000;
let usergroupCache = { data: [], fetchedAt: 0 };

async function getUsergroups(client) {
  if (Date.now() - usergroupCache.fetchedAt < USERGROUP_CACHE_TTL_MS) {
    return usergroupCache.data;
  }
  const resp = await client.usergroups.list();
  usergroupCache = { data: resp.usergroups || [], fetchedAt: Date.now() };
  return usergroupCache.data;
}

function toUsergroupOption(g) {
  return {
    text: { type: 'plain_text', text: `@${g.handle || g.name}` },
    value: g.id,
  };
}

async function getUsergroupOptions(client) {
  try {
    const groups = await getUsergroups(client);
    return groups.map(toUsergroupOption);
  } catch (err) {
    return [];
  }
}

async function getUsergroupMembers(client, groupId) {
  const resp = await client.usergroups.users.list({ usergroup: groupId });
  return resp.users || [];
}

function defaultMessage(birthdayUserId, inviterId) {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Hey! ' },
          { type: 'emoji', name: 'tada' },
          { type: 'text', text: ' ' },
          { type: 'user', user_id: inviterId },
          { type: 'text', text: ' has invited you to a channel for ' },
          birthdayUserId ? { type: 'user', user_id: birthdayUserId } : { type: 'text', text: 'someone' },
          { type: 'text', text: "'s birthday! Click " },
          { type: 'text', text: 'Accept', style: { bold: true } },
          { type: 'text', text: " below and I'll add you to the planning channel." },
        ],
      },
    ],
  };
}

function richInlineToMrkdwn(el) {
  switch (el.type) {
    case 'text': {
      let text = el.text;
      const style = el.style || {};
      if (style.code) text = `\`${text}\``;
      if (style.bold) text = `*${text}*`;
      if (style.italic) text = `_${text}_`;
      if (style.strike) text = `~${text}~`;
      return text;
    }
    case 'user':
      return `<@${el.user_id}>`;
    case 'channel':
      return `<#${el.channel_id}>`;
    case 'usergroup':
      return `<!subteam^${el.usergroup_id}>`;
    case 'emoji':
      return `:${el.name}:`;
    case 'link':
      return el.text ? `<${el.url}|${el.text}>` : el.url;
    case 'broadcast':
      return `<!${el.range}>`;
    default:
      return '';
  }
}

function richTextToMrkdwn(rich) {
  return (rich.elements || [])
    .map((block) => {
      const inline = (els) => (els || []).map(richInlineToMrkdwn).join('');
      switch (block.type) {
        case 'rich_text_list':
          return (block.elements || [])
            .map((item, i) => `${block.style === 'ordered' ? `${i + 1}.` : '•'} ${inline(item.elements)}`)
            .join('\n');
        case 'rich_text_preformatted':
          return '```' + inline(block.elements) + '```';
        case 'rich_text_quote':
          return '> ' + inline(block.elements);
        default:
          return inline(block.elements);
      }
    })
    .join('\n');
}

function isEmptyMessage(message) {
  if (!message) return true;
  if (typeof message === 'string') return !message.trim();
  return !richTextToMrkdwn(message).trim();
}

function messageContent(message) {
  if (typeof message === 'string') {
    return { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }], text: message };
  }
  return { blocks: [message], text: richTextToMrkdwn(message) };
}

async function computeAutoRecipients(client, { sourceChannelId, birthdayUserId, inviterId, groupIds }) {
  const { info, members } = await fetchChannelContext(client, inviterId, sourceChannelId);
  const allMembers = new Set(members);

  for (const groupId of groupIds || []) {
    try {
      const groupMembers = await getUsergroupMembers(client, groupId);
      groupMembers.forEach((id) => allMembers.add(id));
    } catch (err) {
      await reportError(inviterId, `Couldn't read group <!subteam^${groupId}>, so it was skipped`, err);
    }
  }

  const botIds = await getBotUserIds(client, [...allMembers]);
  const recipients = [...allMembers].filter(
    (id) => id !== birthdayUserId && id !== inviterId && !botIds.has(id)
  );

  return { recipients, sourceChannelName: info.channel.name };
}

const DEST_MODE_OPTIONS = [
  { text: { type: 'plain_text', text: 'Create a new private channel for me' }, value: 'create' },
  { text: { type: 'plain_text', text: 'Use a channel I already made' }, value: 'existing' },
];

function buildFormBlocks({
  sourceChannelId,
  birthdayUserId,
  birthdayDate,
  destMode = 'create',
  needsLink = false,
  showMessage = false,
  pickedSelf = false,
  destChannelId,
  channelName,
  groupIds = [],
  messageInput,
  inviterId,
  usergroupOptions = [],
  recipientIds = [],
  autoRecipients = [],
}) {
  const effectiveRecipients = (recipientIds.length ? recipientIds : autoRecipients).filter(
    (id) => id !== birthdayUserId
  );
  const defaultsKey = `${birthdayUserId || 'none'}-${(birthdayDate || '').slice(0, 4)}`;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'This will DM everyone in the channel you pick below (except the birthday ' +
          'person) with an invite! Anyone who accepts will get added to the planning channel you designate.',
      },
    },
    {
      type: 'input',
      block_id: 'source_block',
      label: { type: 'plain_text', text: 'Channel to invite from *' },
      dispatch_action: true,
      element: {
        type: 'conversations_select',
        action_id: 'source_select',
        filter: { include: ['public', 'private'] },
        ...(sourceChannelId ? { initial_conversation: sourceChannelId } : {}),
      },
    },

    ...(usergroupOptions.length
      ? [
          {
            type: 'input',
            block_id: 'group_block',
            label: { type: 'plain_text', text: 'Also invite these groups' },
            optional: true,
            dispatch_action: true,
            element: {
              type: 'multi_external_select',
              action_id: 'group_select',
              placeholder: { type: 'plain_text', text: 'Type to search groups…' },
              min_query_length: 0,
              ...(groupIds.length
                ? { initial_options: usergroupOptions.filter((o) => groupIds.includes(o.value)) }
                : {}),
            },
          },
        ]
      : []),

    {
      type: 'input',
      block_id: 'bday_block',
      label: { type: 'plain_text', text: "Who's the birthday person? *" },
      dispatch_action: true,
      element: {
        type: 'users_select',
        action_id: 'bday_select',
        ...(birthdayUserId ? { initial_user: birthdayUserId } : {}),
      },
    },
    ...(pickedSelf
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: SELF_PICK_WARNING }] }]
      : []),
    {
      type: 'input',
      block_id: 'bday_date_block',
      label: { type: 'plain_text', text: 'When is their birthday? *' },
      dispatch_action: true,
      element: {
        type: 'datepicker',
        action_id: 'bday_date_select',
        ...(birthdayDate ? { initial_date: birthdayDate } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'dest_mode_block',
      label: { type: 'plain_text', text: 'Planning channel *' },
      dispatch_action: true,
      element: {
        type: 'radio_buttons',
        action_id: 'dest_mode_select',
        options: DEST_MODE_OPTIONS,
        initial_option: DEST_MODE_OPTIONS.find((o) => o.value === destMode),
      },
    },
    ...(destMode === 'create'
      ? [{
          type: 'input',
          block_id: versionedBlockId('new_channel_block', defaultsKey),
          label: { type: 'plain_text', text: 'New channel name *' },
          element: {
            type: 'plain_text_input',
            action_id: 'new_channel_input',
            max_length: 80,
            placeholder: { type: 'plain_text', text: 'Fills in once you pick who this is for' },
            ...(channelName ? { initial_value: channelName } : {}),
          },
          hint: {
            type: 'plain_text',
            text: "I'll make it a private channel and add you to it! Make sure to only use lowercase letters, numbers, - and _ only.",
          },
        },
        ...(needsLink ? linkNoticeBlocks(inviterId) : [])]
      : [{
          type: 'input',
          block_id: 'dest_block',
          label: { type: 'plain_text', text: 'Existing planning channel (the one you manage) *' },
          dispatch_action: true,
          element: {
            type: 'conversations_select',
            action_id: 'dest_select',
            filter: { include: ['public', 'private'], exclude_bot_users: true },
            ...(destChannelId ? { initial_conversation: destChannelId } : {}),
          },
        }]),
    ...(showMessage ? [{
      type: 'input',
      block_id: versionedBlockId('message_block', defaultsKey),
      label: { type: 'plain_text', text: 'Message to send *' },
      dispatch_action: true,
      element: {
        type: 'rich_text_input',
        action_id: 'message_input',
        placeholder: { type: 'plain_text', text: 'Write the invite message here' },
        initial_value: isEmptyMessage(messageInput) ? defaultMessage(birthdayUserId, inviterId) : messageInput,
      },
      hint: {
        type: 'plain_text',
        text: "If you want to update what this'll look like, press ctrl + enter! It won't send the thing",
      },
    }] : []),

    ...(showMessage
      ? [
          {
            type: 'input',
            block_id: 'recipients_block',
            label: { type: 'plain_text', text: 'People to invite (add or remove anyone)' },
            optional: true,
            element: {
              type: 'multi_users_select',
              action_id: 'recipients_select',
              placeholder: { type: 'plain_text', text: 'Auto-filled from the channel/groups above' },
              ...(effectiveRecipients.length ? { initial_users: effectiveRecipients } : {}),
            },
          },
        ]
      : []),
  ];
}

const SELF_PICK_WARNING = "That's you! You can't plan your own birthday, pick someone else.";

const WHY_URL = 'https://bdaypheus.ckacha.dev/why';

const NEEDS_LINK_FIELD_ERROR =
  'This needs you to link your Hack Club Auth and Slack first. Check the note below, then close this form and run /bdaypheus again.';

const NEEDS_RELINK_ERRORS = ['missing_scope', 'invalid_auth', 'token_revoked', 'not_authed', 'account_inactive', 'token_expired'];

function linkNoticeBlocks(inviterId) {
  const connectUrl = buildConnectUrl(inviterId);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          ':link: Hey, this needs you to link your Hack Club Auth and Slack to make this work. ' +
          `<${WHY_URL}|Check why here>.`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "Once you've linked, close this form and run */bdaypheus* again. It won't notice the new link until you reopen it.",
        },
      ],
    },
    ...(connectUrl
      ? [
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Connect your Slack account' },
                url: connectUrl,
                action_id: 'connect_account',
              },
            ],
          },
        ]
      : []),
  ];
}

const SUMMARY_BLOCK_ID = 'recipients_block';

const FIELD_LABELS = {
  source_block: 'Channel to invite from',
  bday_block: 'Birthday person',
  bday_date_block: 'Birthday date',
  dest_mode_block: 'Planning channel',
  dest_block: 'Planning channel',
  new_channel_block: 'New channel name',
  message_block: 'Message to send',
};

function inviteModal(blocks, defaults = {}) {
  return {
    type: 'modal',
    callback_id: 'bday_confirm',
    private_metadata: JSON.stringify(defaults),
    title: { type: 'plain_text', text: 'Birthday invite' },
    submit: { type: 'plain_text', text: 'Send invites' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

function toChannelName(raw) {
  return (raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
}

async function getDefaultChannelName(client, birthdayUserId, birthdayDate) {
  const year = (birthdayDate || birthdayStore.todayString()).slice(0, 4);
  let person = 'someone';
  try {
    const { user } = await client.users.info({ user: birthdayUserId });
    person =
      toChannelName(user.profile && user.profile.display_name) ||
      toChannelName(user.real_name) ||
      toChannelName(user.name) ||
      person;
  } catch (err) {
  }
  return toChannelName(`${person}-birthday-${year}`);
}

async function createPlanningChannel(client, name) {
  const candidates = [name, `${name.slice(0, 78).replace(/[-_]+$/, '')}-2`];
  for (const candidate of candidates) {
    try {
      const resp = await client.conversations.create({ name: candidate, is_private: true });
      return { channelId: resp.channel.id };
    } catch (err) {
      const code = errorDetail(err);
      if (code !== 'name_taken') return { error: code };
    }
  }
  return { error: 'name_taken' };
}

async function sendInviteDms(client, userIds, { blocks, text }, buttonValue) {
  const sent = [];
  const failures = [];

  for (const userId of userIds) {
    try {
      const im = await client.conversations.open({ users: userId });
      const posted = await client.chat.postMessage({
        channel: im.channel.id,
        text,
        blocks: [
          ...blocks,
          {
            type: 'actions',
            block_id: 'bday_response',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Accept' },
                style: 'primary',
                action_id: 'bday_accept',
                value: buttonValue,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Decline' },
                action_id: 'bday_decline',
                value: buttonValue,
              },
            ],
          },
        ],
      });
      sent.push({ userId, channel: posted.channel || im.channel.id, ts: posted.ts });
    } catch (err) {
      failures.push(userId);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { sent, failures };
}

const notifiedAccessFailures = new Set();

async function checkDestChannelAccess(client, destChannelId) {
  try {
    await client.conversations.info({ channel: destChannelId });
    return true;
  } catch (err) {
    return false;
  }
}

async function buildPreview(
  client,
  { sourceChannelId, birthdayUserId, inviterId, groupIds, messageInput, destChannelId, showMessage }
) {
  const blocks = [];
  let autoRecipients = [];

  if (destChannelId) {
    const canAccessDest = await checkDestChannelAccess(client, destChannelId);
    if (!canAccessDest) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:warning: I can't add people to that channel (the one you're inviting *into*)! Make sure ` +
            `${BOT_USER_ID ? `<@${BOT_USER_ID}>` : '@bdaypheus'} has been invited to it, then try again.`,
        },
      });
    }
  }

  if (!sourceChannelId) return { blocks, autoRecipients };

  try {
    const { recipients, sourceChannelName } = await computeAutoRecipients(client, {
      sourceChannelId,
      birthdayUserId,
      inviterId,
      groupIds,
    });
    autoRecipients = recipients;

    if (showMessage) {
      const message = isEmptyMessage(messageInput) ? defaultMessage(birthdayUserId, inviterId) : messageInput;
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*btw, this is what recipients will receive:*' },
      });
      blocks.push(...messageContent(message).blocks);

      const groupNote = groupIds && groupIds.length
        ? ` + ${groupIds.length} group${groupIds.length === 1 ? '' : 's'}`
        : '';
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Auto-filled ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} from #${sourceChannelName}${groupNote} into the list below. Edit it to add or remove anyone.`,
          },
        ],
      });
    }
  } catch (err) {
    blocks.push({ type: 'divider' });
    const dmKey = `${inviterId}:${sourceChannelId}:${err.needsConnect ? 'connect' : 'error'}`;
    const alreadyNotified = notifiedAccessFailures.has(dmKey);
    notifiedAccessFailures.add(dmKey);

    if (err.needsConnect) {
      const connectUrl = buildConnectUrl(inviterId);

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:lock: That's a private channel this bot is not in (the one you're inviting *from*). ` +
            `I've sent you a DM with how to connect your Slack account. Once you connect, try again! `
        },
      });

      if (!alreadyNotified) {
        await client.chat.postMessage({
          channel: inviterId,
          text: `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account to let me read it.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  `:lock: <#${sourceChannelId}> (the channel you're inviting *from*) is a private channel I'm ` +
                  "not in. Connect your Slack account (you'll verify with Hack Club Auth first) with " +
                  "/link-bdaypheus, or the dm that I sent you.",
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: CONSENT_WARNING },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Connect your Slack account' },
                  url: connectUrl,
                  action_id: 'connect_account',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'View setup docs' },
                  url: README_URL,
                  action_id: 'view_readme',
                },
              ],
            },
          ],
        });
      }
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: Couldn't load a preview for that channel, the one you're inviting *from* (${err.data ? err.data.error : err.message}). Make sure ${BOT_USER_ID ? `<@${BOT_USER_ID}>` : '@bdaypheus'} has been invited to it.`,
        },
      });
      if (!alreadyNotified) {
        await reportError(inviterId, `Couldn't read <#${sourceChannelId}>`, err);
      }
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View setup docs' },
            url: README_URL,
            action_id: 'view_readme',
          },
        ],
      });
    }
  }

  return { blocks, autoRecipients };
}

function versionedBlockId(base, key) {
  return key ? `${base}.${key}` : base;
}

function findBlockId(ids, base) {
  return ids.find((id) => id === base || id.startsWith(`${base}.`));
}

function readFormState(values) {
  const groupSelect = values.group_block && values.group_block.group_select;
  const recipientsSelect = values.recipients_block && values.recipients_block.recipients_select;
  const channelBlock = values[findBlockId(Object.keys(values), 'new_channel_block')];
  const messageBlock = values[findBlockId(Object.keys(values), 'message_block')];
  return {
    sourceChannelId: values.source_block && values.source_block.source_select.selected_conversation,
    birthdayUserId: values.bday_block && values.bday_block.bday_select.selected_user,
    birthdayDate: values.bday_date_block && values.bday_date_block.bday_date_select.selected_date,
    destMode:
      (values.dest_mode_block &&
        values.dest_mode_block.dest_mode_select.selected_option &&
        values.dest_mode_block.dest_mode_select.selected_option.value) ||
      'create',
    destChannelId: values.dest_block && values.dest_block.dest_select.selected_conversation,
    channelName: channelBlock && channelBlock.new_channel_input.value,
    groupIds: (groupSelect && groupSelect.selected_options ? groupSelect.selected_options : []).map(
      (o) => o.value
    ),
    recipientIds: (recipientsSelect && recipientsSelect.selected_users) || [],
    messageInput: messageBlock && messageBlock.message_input.rich_text_value,
  };
}

async function refreshModal(body, client) {
  const inviterId = body.user.id;
  try {
    const {
      sourceChannelId,
      birthdayUserId: pickedBirthdayUserId,
      birthdayDate,
      destMode,
      destChannelId,
      channelName,
      groupIds,
      recipientIds,
      messageInput,
    } = readFormState(body.view.state.values);
    const pickedSelf = pickedBirthdayUserId === inviterId;
    const birthdayUserId = pickedSelf ? null : pickedBirthdayUserId;

    let previous = {};
    try {
      previous = JSON.parse(body.view.private_metadata || '{}');
    } catch (err) {}

    const defaultMsg = defaultMessage(birthdayUserId, inviterId);
    const messageUntouched =
      isEmptyMessage(messageInput) || richTextToMrkdwn(messageInput) === previous.defaultMessageText;
    const message = messageUntouched ? defaultMsg : messageInput;

    const previewDestId = destMode === 'existing' ? destChannelId : null;
    const showMessage = Boolean(sourceChannelId && birthdayUserId && birthdayDate);
    const [usergroupOptions, preview, defaultChannelName] = await Promise.all([
      getUsergroupOptions(client),
      buildPreview(client, {
        sourceChannelId,
        birthdayUserId,
        inviterId,
        groupIds,
        messageInput: message,
        destChannelId: previewDestId,
        showMessage,
      }),
      birthdayUserId ? getDefaultChannelName(client, birthdayUserId, birthdayDate) : null,
    ]);

    const nameUntouched = !channelName || channelName === previous.defaultChannelName;
    const resolvedChannelName = nameUntouched ? defaultChannelName || channelName : channelName;

    const formBlocks = buildFormBlocks({
      needsLink: !tokenStore.get(inviterId),
      showMessage,
      pickedSelf,
      sourceChannelId,
      birthdayUserId,
      birthdayDate,
      destMode,
      destChannelId,
      channelName: resolvedChannelName,
      groupIds,
      messageInput: message,
      inviterId,
      usergroupOptions,
      recipientIds,
      autoRecipients: preview.autoRecipients,
    });
    const recipientsIndex = formBlocks.findIndex((b) => b.block_id === 'recipients_block');
    const blocks =
      recipientsIndex === -1
        ? [...formBlocks, ...preview.blocks]
        : [...formBlocks.slice(0, recipientsIndex), ...preview.blocks, ...formBlocks.slice(recipientsIndex)];

    await client.views.update({
      view_id: body.view.id,
      view: inviteModal(blocks, {
        defaultMessageText: richTextToMrkdwn(defaultMsg),
        defaultChannelName,
      }),
    });
  } catch (err) {
    if (errorDetail(err) === 'not_found') return;
    await reportError(inviterId, "Couldn't update the invite form", err);
  }
}

app.command('/bdaypheus', async ({ command, ack, client, respond }) => {
  await ack();

  const needsLink = !tokenStore.get(command.user_id);
  const startDefaults = { defaultMessageText: richTextToMrkdwn(defaultMessage(null, command.user_id)) };
  let opened;
  try {
    opened = await client.views.open({
      trigger_id: command.trigger_id,
      view: inviteModal(buildFormBlocks({ inviterId: command.user_id, needsLink }), startDefaults),
    });
  } catch (err) {
    await respond({
      response_type: 'ephemeral',
      text: `:warning: Couldn't open the invite form (${errorDetail(err)}). Try running /bdaypheus again!`,
    });
    await notifyAdmin("Couldn't open the /bdaypheus form", command.user_id, errorDetail(err));
    return;
  }

  const usergroupOptions = await getUsergroupOptions(client);
  if (!usergroupOptions.length) return;
  try {
    await client.views.update({
      view_id: opened.view.id,
      hash: opened.view.hash,
      view: inviteModal(buildFormBlocks({ inviterId: command.user_id, needsLink, usergroupOptions }), startDefaults),
    });
  } catch (err) {
  }
});

app.command('/link-bdaypheus', async ({ command, ack, respond }) => {
  await ack();

  if (!CHAIN_ENABLED) {
    await respond({
      response_type: 'ephemeral',
      text: 'The account-connect flow isn\'t configured yet (missing PUBLIC_BASE_URL/client credentials).',
    });
    return;
  }

  if (tokenStore.get(command.user_id)) {
    await respond({
      response_type: 'ephemeral',
      text: "You're already connected! I'll use that connection automatically next time I need to read a private channel you're in.",
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              ":white_check_mark: You're already connected! No need to do this again! I'll use it " +
              "automatically the next time I need to read a private channel you're in.",
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'If Slack access was revoked or something seems off, use the button below to reconnect.',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reconnect anyway' },
              url: buildConnectUrl(command.user_id),
              action_id: 'connect_account',
            },
          ],
        },
      ],
    });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: 'Connect your Slack account (verifies with Hack Club Auth first) so I can read private channels you\'re in:',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Connect your Slack account so I can read private channels you\'re in ' +
            "you'll verify with Hack Club Auth first, then grant Slack access.",
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: CONSENT_WARNING },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Connect your Slack account' },
            url: buildConnectUrl(command.user_id),
            action_id: 'connect_account',
          },
        ],
      },
    ],
  });
});

app.command('/unlink-bdaypheus', async ({ command, ack, respond }) => {
  await ack();

  if (!tokenStore.get(command.user_id)) {
    await respond({
      response_type: 'ephemeral',
      text: "You don't have a connected Slack account to unlink.",
    });
    return;
  }

  let revokeFailure = null;
  try {
    await new WebClient(tokenStore.get(command.user_id)).auth.revoke();
  } catch (err) {
    const code = errorDetail(err);
    const alreadyDead = ['token_revoked', 'invalid_auth', 'account_inactive'].includes(code);
    if (!alreadyDead) revokeFailure = code;
  }

  tokenStore.remove(command.user_id);

  if (revokeFailure) {
    await notifyAdmin('Personal Slack token removed but revoke failed', command.user_id, revokeFailure);
    await respond({
      response_type: 'ephemeral',
      text:
        `:warning: I deleted your token from my storage, but Slack didn't confirm revoking it (\`${revokeFailure}\`). ` +
        "To be safe, remove the app's access yourself under Slack's *Apps → Manage → Connected apps* settings.",
    });
    return;
  }

  await notifyAdmin('Personal Slack token removed', command.user_id, 'user ran /unlink-bdaypheus');

  await respond({
    response_type: 'ephemeral',
    text:
      ":white_check_mark: Your connected Slack account (token) was revoked and removed.\n\n" +
      ":warning: *Heads up:* until you reconnect, I won't be able to invite people from a *private* channel " +
      "you're not letting me read (I'll prompt you to reconnect if you try). This doesn't affect adding people " +
      "to a private *planning* channel: that only needs me to already be a member of it, not your token.",
  });
});

function pendingInvitees(record) {
  return Object.keys(record.invites || {}).filter(
    (userId) => birthdayStore.statusOf(record.invites[userId]) === 'pending'
  );
}

function shortDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

async function displayName(client, userId) {
  try {
    const { user } = await client.users.info({ user: userId });
    return (user.profile && user.profile.display_name) || user.real_name || user.name || userId;
  } catch (err) {
    return userId;
  }
}

async function sendRemindersFor(client, inviterId, birthdayUserId, record) {
  try {
    const destMembers = new Set(await getChannelMembers(botClient, record.destChannelId));
    for (const userId of Object.keys(record.invites || {})) {
      if (birthdayStore.statusOf(record.invites[userId]) === 'pending' && destMembers.has(userId)) {
        birthdayStore.markResponse(birthdayUserId, userId, 'accepted');
      }
    }
  } catch (err) {
  }

  const pending = pendingInvitees(record);
  if (!pending.length) {
    await client.chat.postMessage({
      channel: inviterId,
      text: `:white_check_mark: Everyone invited for <@${birthdayUserId}>'s birthday has already responded!`,
    });
    return;
  }

  let sentCount = 0;
  const failures = [];
  for (const userId of pending) {
    const invite = record.invites[userId];
    let permalink = null;
    if (invite && invite.channel && invite.ts) {
      try {
        ({ permalink } = await client.chat.getPermalink({ channel: invite.channel, message_ts: invite.ts }));
      } catch (err) {
      }
    }

    const text =
      "Hey, it looks like you haven't responded to the initial invite, please do!" +
      (permalink ? `\n${permalink}` : '');
    try {
      const im = await client.conversations.open({ users: userId });
      await client.chat.postMessage({ channel: im.channel.id, text, unfurl_links: true });
      sentCount += 1;
    } catch (err) {
      failures.push(userId);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const lines = [
    `:yay: Sent reminders to ${sentCount} ${sentCount === 1 ? 'person' : 'people'} who haven't responded yet for <@${birthdayUserId}>'s birthday.`,
  ];
  if (failures.length) {
    lines.push(`Couldn't DM: ${failures.map((id) => `<@${id}>`).join(', ')}`);
  }
  await client.chat.postMessage({
    channel: inviterId,
    text: lines.join('\n'),
  });
}

async function reminderPickerModal(client, active) {
  const useRadio = active.length <= 10;
  const options = await Promise.all(
    active.map(async ({ birthdayUserId, record }) => {
      const waiting = pendingInvitees(record).length;
      const details = `${shortDate(record.date)} · ${waiting} ${waiting === 1 ? "hasn't" : "haven't"} responded`;
      return {
        text: useRadio
          ? { type: 'mrkdwn', text: `<@${birthdayUserId}>'s birthday · ${details}` }
          : { type: 'plain_text', text: `${await displayName(client, birthdayUserId)}'s birthday · ${details}`.slice(0, 75) },
        value: birthdayUserId,
      };
    })
  );

  return {
    type: 'modal',
    callback_id: 'reminder_pick',
    title: { type: 'plain_text', text: 'Send reminders' },
    submit: { type: 'plain_text', text: 'Send reminders' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reminder_pick_block',
        label: { type: 'plain_text', text: 'Which birthday card do you want to remind? *' },
        element:
          useRadio
            ? { type: 'radio_buttons', action_id: 'reminder_pick_select', options }

            : {
                type: 'static_select',
                action_id: 'reminder_pick_select',
                placeholder: { type: 'plain_text', text: 'Pick a birthday' },
                options: options.slice(0, 100),
              },

        hint: {
          type: 'plain_text',
          text: "I'll DM everyone who hasn't accepted or declined yet, with a link to their original invite.",
        },
      },
    ],
  };
}

app.command('/send-reminders', async ({ command, ack, client }) => {
  await ack();

  const inviterId = command.user_id;
  const mentionMatch = (command.text || '').match(/<@([A-Z0-9]+)(\|[^>]*)?>/);
  const mentionedId = mentionMatch && mentionMatch[1];
  const active = birthdayStore.getActiveByInviter(inviterId);

  if (mentionedId) {
    const entry = active.find((e) => e.birthdayUserId === mentionedId);
    if (!entry) {
      const other = birthdayStore.getActive(mentionedId);
      await client.chat.postMessage({
        channel: inviterId,
        text: other
          ? `Only <@${other.inviterId}> can send reminders for <@${mentionedId}>'s birthday, since they sent the invites.`
          : `You don't have any invites out for <@${mentionedId}>'s birthday.`,
      });

      return;
    }

    await sendRemindersFor(client, inviterId, entry.birthdayUserId, entry.record);
    return;
  }

  if (!active.length) {
    await client.chat.postMessage({
      channel: inviterId,
      text: "You don't have any birthday invites out right now. Send some with /bdaypheus first!",
    });

    return;
  }

  if (active.length === 1) {
    await sendRemindersFor(client, inviterId, active[0].birthdayUserId, active[0].record);
    return;
  }

  try {
    await client.views.open({ trigger_id: command.trigger_id, view: await reminderPickerModal(client, active) });
  } catch (err) {
    await client.chat.postMessage({
      channel: inviterId,
      text:
        `:warning: Couldn't open the reminder picker (${errorDetail(err)}). You have invites out for ` +
        `${active.map((e) => `<@${e.birthdayUserId}>`).join(', ')}, so you can also run \`/send-reminders @person\`.`,
    });
    
    await notifyAdmin("Couldn't open the /send-reminders picker", inviterId, errorDetail(err));
  }
});

app.view('reminder_pick', async ({ ack, view, body, client }) => {
  const inviterId = body.user.id;
  const pick = view.state.values.reminder_pick_block.reminder_pick_select;
  const birthdayUserId = pick.selected_option && pick.selected_option.value;
  const record = birthdayUserId && birthdayStore.getActive(birthdayUserId);

  if (!record || record.inviterId !== inviterId) {
    await ack({
      response_action: 'errors',
      errors: { reminder_pick_block: "That birthday isn't one of yours anymore (it may have passed). Pick another one." },
    });
    return;
  }

  await ack();
  await sendRemindersFor(client, inviterId, birthdayUserId, record);
});

app.action('source_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('bday_date_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('dest_mode_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('dest_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('bday_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('group_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('message_input', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.options('group_select', async ({ ack, payload, client }) => {
  const query = (payload.value || '').toLowerCase();
  let groups = [];
  try {
    groups = await getUsergroups(client);
  } catch (err) {
    await ack({ options: [] });
    return;
  }

  const options = groups
    .filter((g) => {
      const handle = (g.handle || '').toLowerCase();
      const name = (g.name || '').toLowerCase();
      return !query || handle.includes(query) || name.includes(query);
    })
    .slice(0, MAX_USERGROUP_SUGGESTIONS)
    .map(toUsergroupOption);

  await ack({ options });
});


app.action('connect_account', async ({ ack }) => {
  await ack();
});

app.action('view_readme', async ({ ack }) => {
  await ack();
});

app.view('bday_confirm', async ({ ack, view, client, body }) => {
  const inviterId = body.user.id;
  const { sourceChannelId, birthdayUserId, birthdayDate, destMode, channelName, groupIds, recipientIds, messageInput } =
    readFormState(view.state.values);
  let { destChannelId } = readFormState(view.state.values);

  const rejectSubmit = (errors) => {
    const failed = [...new Set(Object.keys(errors).map((id) => FIELD_LABELS[id] || id))];
    const viewIds = view.blocks.map((b) => b.block_id).filter(Boolean);
    const mapped = {};
    for (const [base, message] of Object.entries(errors)) {
      mapped[findBlockId(viewIds, base) || base] = message;
    }
    if (viewIds.includes(SUMMARY_BLOCK_ID) && !mapped[SUMMARY_BLOCK_ID]) {
      mapped[SUMMARY_BLOCK_ID] = `:warning: Couldn't send yet. Fix ${failed.join(', ')} above.`;
    }
    return ack({ response_action: 'errors', errors: mapped });
  };

  if (birthdayUserId === inviterId) {
    await rejectSubmit({ bday_block: "That's you! You can't plan your own birthday, pick someone else." });
    return;
  }

  const existing = birthdayStore.getActive(birthdayUserId);
  if (existing && existing.inviterId !== inviterId) {
    await ack();
    await client.chat.postMessage({
      channel: inviterId,
      text:
        `Hey, <@${existing.inviterId}> already sent out invites for <@${birthdayUserId}>'s birthday! ` +
        `DM <@${existing.inviterId}> if you want to help out.`,
    });
    return;
  }

  const fieldErrors = {};
  if (birthdayDate < birthdayStore.todayString()) {
    fieldErrors.bday_date_block = 'That date already passed! Pick their upcoming birthday.';
  }
  if (destMode === 'existing') {
    if (destChannelId === sourceChannelId) {
      fieldErrors.dest_block = "Pick a different channel than the one you're inviting from.";
    } else {
      try {
        await botClient.conversations.info({ channel: destChannelId });
      } catch (err) {
        fieldErrors.dest_block = `I'm not in that channel yet (${errorDetail(err)}). Invite me to it first, then try again.`;
      }
    }
  }
  if (Object.keys(fieldErrors).length) {
    await rejectSubmit(fieldErrors);
    return;
  }

  let createdChannel = false;
  if (destMode === 'create') {
    const userToken = tokenStore.get(inviterId);
    if (!userToken) {
      await rejectSubmit({ dest_mode_block: NEEDS_LINK_FIELD_ERROR });
      return;
    }
    const userClient = new WebClient(userToken);

    const name =
      toChannelName(channelName) || (await getDefaultChannelName(client, birthdayUserId, birthdayDate));
    const { channelId, error } = await createPlanningChannel(userClient, name);

    if (error) {
      const needsRelink = NEEDS_RELINK_ERRORS.includes(error);
      const errors =
        error === 'name_taken'
          ? { new_channel_block: `#${name} is already taken (so is #${name}-2). Try a different name.` }
          : error.startsWith('invalid_name')
          ? { new_channel_block: 'Channel names can only use lowercase letters, numbers, - and _ (max 80 characters).' }
          : needsRelink
          ? { dest_mode_block: `Your linked account needs reconnecting (${error}). I DMed you a button to do it.` }
          : error === 'restricted_action'
          ? { dest_mode_block: "Slack won't let your account create private channels. Pick \"Use a channel I already made\" instead." }
          : { dest_mode_block: `Couldn't create the channel (${error}). Try again, or use a channel you already made.` };
      if (needsRelink) {
        await client.chat.postMessage({
          channel: inviterId,
          text: 'Hey, this needs you to link your Hack Club Auth and Slack to make this work.',
          blocks: linkNoticeBlocks(inviterId),
        });
      } else if (!errors.new_channel_block) {
        await notifyAdmin("Couldn't create a planning channel", inviterId, error);
      }
      await rejectSubmit(errors);
      return;
    }

    try {
      await userClient.conversations.invite({ channel: channelId, users: BOT_USER_ID });
    } catch (err) {
      await rejectSubmit({
        dest_mode_block:
          `I made #${name} for you, but couldn't join it (${errorDetail(err)}). Invite me to it, ` +
          'then pick it under "Use a channel I already made".',
      });
      return;
    }

    destChannelId = channelId;
    createdChannel = true;
  }

  await ack();

  let toMessage = recipientIds.filter((id) => id !== birthdayUserId);
  if (!recipientIds.length) {
    try {
      const ctx = await computeAutoRecipients(client, { sourceChannelId, birthdayUserId, inviterId, groupIds });
      toMessage = ctx.recipients;
    } catch (err) {
      if (err.needsConnect) {
        await client.chat.postMessage({
          channel: inviterId,
          text:
            `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account ` +
            `(you'll verify with Hack Club Auth first), then run /bdaypheus again: ${buildConnectUrl(inviterId)}\n\n` +
            `${CONSENT_WARNING}\n\nSetup docs: ${README_URL}`,
        });
      } else {
        await reportError(inviterId, `Couldn't read <#${sourceChannelId}>`, err);
      }
      return;
    }
  }

  if (!toMessage.length) {
    await client.chat.postMessage({
      channel: inviterId,
      text: "There's nobody in the invite list! Add someone in the \"People to invite\" field and try again.",
    });
    return;
  }

  const message = isEmptyMessage(messageInput) ? defaultMessage(birthdayUserId, inviterId) : messageInput;

  const buttonValue = JSON.stringify({
    dest: destChannelId,
    bday: birthdayUserId,
    inviter: inviterId,
  });

  const { sent: sentInvites, failures } = await sendInviteDms(client, toMessage, messageContent(message), buttonValue);
  const sent = sentInvites.length;

  if (sent) {
    birthdayStore.set(birthdayUserId, { date: birthdayDate, inviterId, destChannelId, message });
    birthdayStore.addInvites(birthdayUserId, sentInvites);
  }

  const summaryLines = [
    `:yay: Successfully sent messages to ${sent} ${sent === 1 ? 'person' : 'people'} (based on <#${sourceChannelId}>) for <@${birthdayUserId}>'s birthday.`,
    ...(createdChannel
      ? [`I made <#${destChannelId}> as the planning channel. You're its channel manager, and anyone who accepts lands there.`]
      : []),
  ];
  
  if (failures.length) {
    summaryLines.push(`Couldn't DM: ${failures.map((id) => `<@${id}>`).join(', ')}`);
    await notifyAdmin(
      `${failures.length} of ${toMessage.length} birthday invite DMs failed to send`,
      inviterId,
      `for <@${birthdayUserId}>'s birthday. Failed: ${failures.map((id) => `<@${id}>`).join(', ')}`
    );
  }

  await client.chat.postMessage({
    channel: inviterId,
    text: summaryLines.join('\n'),
  });
});

app.action('bday_accept', async ({ ack, body, client, action }) => {
  await ack();
  const { dest, bday, inviter } = JSON.parse(action.value);

  if (body.user.id === bday) {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: "This is your birthday celebration — I can't add you to the planning channel!",
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ":sparkles: This one's *your* birthday celebration, so I can't add you to the planning channel. Enjoy the surprise!",
          },
        },
      ],
    });
    return;
  }

  try {
    await client.conversations.invite({ channel: dest, users: body.user.id });
  } catch (err) {
    const code = err.data ? err.data.error : err.message;
    if (code !== 'already_in_channel') {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `I couldn't add you to the planning channel (${code}). Ask <@${inviter}> to invite me to it and try again.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:warning: I couldn't add you to the planning channel (\`${code}\`). Ask <@${inviter}> to invite me to it and try again.`,
            },
          },
        ],
      });
      await notifyAdmin("Couldn't add someone to a planning channel", body.user.id, code);
      return;
    }
  }

  birthdayStore.markResponse(bday, body.user.id, 'accepted');

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `You're in! I've added you to <#${dest}>.`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:tada: You're in! I've added you to <#${dest}>. Shh, don't tell <@${bday}>!` },
      },
    ],
  });
});

app.action('bday_decline', async ({ ack, body, client, action }) => {
  await ack();
  const { bday } = JSON.parse(action.value);
  birthdayStore.markResponse(bday, body.user.id, 'declined');

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: 'No worries, maybe next time!',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'No worries, maybe next time!' } },
    ],
  });
});

app.event('app_mention', async ({ event, client }) => {
  try {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: 'pstt use /bdaypheus or check out <https://bdaypheus.ckacha.dev|bdaypheus.ckacha.dev>!',
    });
  } catch (err) {
    await notifyAdmin("Couldn't answer a ping", event.user, errorDetail(err));
  }
});

(async () => {
  const auth = await botClient.auth.test();
  BOT_USER_ID = auth.user_id;

  await app.start();
  console.log('bday-bot is running (Socket Mode)');
})();
