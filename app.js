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

// long story short it worked
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
   //idk if i should add more error handeling above this, should be fine?
  }
}

// error handeling | works
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
  'private channels you are a part of. Read the full info in <https://github.com/CKacha/bday-bot/blob/main/docs/warning.md|the warning file>. ' +
  'You can revoke the token at any time by running /unlink-bdaypheus ';

const pendingConnections = new Map();

function buildConnectUrl(inviterId) {
  if (!CHAIN_ENABLED) return null;
  return `${PUBLIC_BASE_URL}/connect/start?slack_user=${encodeURIComponent(inviterId)}`;
}

function slackAuthorizeUrl(state) {
  return (
    `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}` +
    `&user_scope=groups:read,channels:read` +
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

    // connection to hc auth
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

    // hc oauth
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

    // should callback to slack if it works
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
        sendHtml(res, 200, 'Connected! You can close this tab and go back to Slack.');
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
      // error handeling should probably be sent as a dm
      //do soon
    }
  }
  return botIds;
}

const MAX_USERGROUP_SUGGESTIONS = 100; // figure out group preloading
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
    // should only happen with usergroups:read scope missing/failed
    return [];
  }
}

async function getUsergroupMembers(client, groupId) {
  const resp = await client.usergroups.users.list({ usergroup: groupId });
  return resp.users || [];
}

function defaultMessage(birthdayUserId, inviterId) {
  return (
    `Hey! :tada: <@${inviterId}> has invited you to a channel for <@${birthdayUserId}>'s birthday! ` +
    `Click *Accept* below and I'll add you to the planning channel.`
  );
}

//fixed group and channel members
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

function buildFormBlocks({
  sourceChannelId,
  birthdayUserId,
  birthdayDate,
  destChannelId,
  groupIds = [],
  messageInput,
  inviterId,
  usergroupOptions = [],
  recipientIds = [],
  autoRecipients = [],
}) {
  // The birthday person is never a valid recipient — strip them from whatever list we show.
  const effectiveRecipients = (recipientIds.length ? recipientIds : autoRecipients).filter(
    (id) => id !== birthdayUserId
  );

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
      label: { type: 'plain_text', text: 'Channel to invite from' },
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
      label: { type: 'plain_text', text: "Who's the birthday person?" },
      dispatch_action: true,
      element: {
        type: 'users_select',
        action_id: 'bday_select',
        ...(birthdayUserId ? { initial_user: birthdayUserId } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'bday_date_block',
      label: { type: 'plain_text', text: 'When is their birthday?' },
      element: {
        type: 'datepicker',
        action_id: 'bday_date_select',
        ...(birthdayDate ? { initial_date: birthdayDate } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'dest_block',
      label: { type: 'plain_text', text: 'Planning channel (the one you manage)' },
      dispatch_action: true,
      element: {
        type: 'conversations_select',
        action_id: 'dest_select',
        filter: { include: ['public', 'private'], exclude_bot_users: true },
        ...(destChannelId ? { initial_conversation: destChannelId } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'message_block',
      label: { type: 'plain_text', text: 'Message to send' },
      optional: true,
      dispatch_action: true,
      element: {
        type: 'plain_text_input',
        action_id: 'message_input',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: 'Fills in automatically once you pick who this is for! Feel free to edit it.',
        },
        ...(messageInput
          ? { initial_value: messageInput }
          : birthdayUserId
          ? { initial_value: defaultMessage(birthdayUserId, inviterId) }
          : {}),
      },
    },

    ...(sourceChannelId
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

async function sendInviteDms(client, userIds, messageText, buttonValue) {
  const sentIds = [];
  const failures = [];

  for (const userId of userIds) {
    try {
      const im = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: im.channel.id,
        text: messageText,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: messageText } },
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
      sentIds.push(userId);
    } catch (err) {
      failures.push(userId);
    }
    // rate limit evventually test if the timeout happens
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { sentIds, failures };
}

// no tweeking okease
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
  { sourceChannelId, birthdayUserId, inviterId, groupIds, messageInput, destChannelId }
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

  blocks.push({ type: 'divider' });

  try {
    const { recipients, sourceChannelName } = await computeAutoRecipients(client, {
      sourceChannelId,
      birthdayUserId,
      inviterId,
      groupIds,
    });
    autoRecipients = recipients;

    const messageText = birthdayUserId
      ? (messageInput || '').trim() || defaultMessage(birthdayUserId, inviterId)
      : null;

    if (messageText) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*btw, this is what recipients will receive:*\n${messageText}` },
      });
    }

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
  } catch (err) {
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

function readFormState(values) {
  const groupSelect = values.group_block && values.group_block.group_select;
  const recipientsSelect = values.recipients_block && values.recipients_block.recipients_select;
  return {
    sourceChannelId: values.source_block && values.source_block.source_select.selected_conversation,
    birthdayUserId: values.bday_block && values.bday_block.bday_select.selected_user,
    birthdayDate: values.bday_date_block && values.bday_date_block.bday_date_select.selected_date,
    destChannelId: values.dest_block && values.dest_block.dest_select.selected_conversation,
    groupIds: (groupSelect && groupSelect.selected_options ? groupSelect.selected_options : []).map(
      (o) => o.value
    ),
    recipientIds: (recipientsSelect && recipientsSelect.selected_users) || [],
    messageInput: values.message_block && values.message_block.message_input.value,
  };
}

async function refreshModal(body, client) {
  const inviterId = body.user.id;
  const { sourceChannelId, birthdayUserId, birthdayDate, destChannelId, groupIds, recipientIds, messageInput } =
    readFormState(body.view.state.values);

  const [usergroupOptions, preview] = await Promise.all([
    getUsergroupOptions(client),
    buildPreview(client, { sourceChannelId, birthdayUserId, inviterId, groupIds, messageInput, destChannelId }),
  ]);

  await client.views.update({
    view_id: body.view.id,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        ...buildFormBlocks({
          sourceChannelId,
          birthdayUserId,
          birthdayDate,
          destChannelId,
          groupIds,
          messageInput,
          inviterId,
          usergroupOptions,
          recipientIds,
          autoRecipients: preview.autoRecipients,
        }),
        ...preview.blocks,
      ],
    },
  });
}

app.command('/bdaypheus', async ({ command, ack, client }) => {
  await ack();

  const usergroupOptions = await getUsergroupOptions(client);

  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: buildFormBlocks({ inviterId: command.user_id, usergroupOptions }),
    },
  });
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

app.command('/send-reminders', async ({ command, ack, respond, client }) => {
  await ack();

  const inviterId = command.user_id;
  const mentionMatch = (command.text || '').match(/<@([A-Z0-9]+)(\|[^>]*)?>/);
  const mentionedId = mentionMatch && mentionMatch[1];
  const active = birthdayStore.getActiveByInviter(inviterId);

  let entry;
  if (mentionedId) {
    entry = active.find((e) => e.birthdayUserId === mentionedId);
    if (!entry) {
      const other = birthdayStore.getActive(mentionedId);
      await respond({
        response_type: 'ephemeral',
        text: other
          ? `Only <@${other.inviterId}> can send reminders for <@${mentionedId}>'s birthday, since they sent the invites.`
          : `You don't have any invites out for <@${mentionedId}>'s birthday.`,
      });

      return;
    }

  } else if (active.length === 1) {
    entry = active[0];

  } else {
    await respond({
      response_type: 'ephemeral',
      text: active.length
        ? `You have invites out for ${active.map((e) => `<@${e.birthdayUserId}>`).join(', ')}. ` +
          'Pick one with `/send-reminders @person`.'
        : "You don't have any birthday invites out right now. Send some with /bdaypheus first!",
    });

    return;
  }

  const { birthdayUserId, record } = entry;

  try {
    const destMembers = new Set(await getChannelMembers(botClient, record.destChannelId));
    for (const userId of Object.keys(record.invites || {})) {
      if (record.invites[userId] === 'pending' && destMembers.has(userId)) {
        birthdayStore.markResponse(birthdayUserId, userId, 'accepted');
      }
    }
  } catch (err) {
  }

  const pending = Object.keys(record.invites || {}).filter((userId) => record.invites[userId] === 'pending');
  if (!pending.length) {
    await respond({
      response_type: 'ephemeral',
      text: `:white_check_mark: Everyone invited for <@${birthdayUserId}>'s birthday has already responded!`,
    });

    return;
  }

  const messageText =
    ':alarm_clock: *Reminder:* ' + (record.message || defaultMessage(birthdayUserId, inviterId));
  const buttonValue = JSON.stringify({ dest: record.destChannelId, bday: birthdayUserId, inviter: inviterId });

  const { sentIds, failures } = await sendInviteDms(client, pending, messageText, buttonValue);

  const lines = [
    `:yay: Sent reminders to ${sentIds.length} ${sentIds.length === 1 ? 'person' : 'people'} who haven't responded yet for <@${birthdayUserId}>'s birthday.`,
  ];
  
  if (failures.length) {
    lines.push(`Couldn't DM: ${failures.map((id) => `<@${id}>`).join(', ')}`);
  }
  await respond({ response_type: 'ephemeral', text: lines.join('\n') });
});

app.action('source_select', async ({ ack, body, client }) => {
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
  const { sourceChannelId, birthdayUserId, birthdayDate, destChannelId, groupIds, recipientIds, messageInput } =
    readFormState(view.state.values);

  if (birthdayDate < birthdayStore.todayString()) {
    await ack({
      response_action: 'errors',
      errors: {
        bday_date_block: "That date already passed! Pick their upcoming birthday.",
      },
    });
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

  if (destChannelId === sourceChannelId) {
    await ack({
      response_action: 'errors',
      errors: {
        dest_block: 'Pick a different channel than the one you\'re inviting from.',
      },
    });
    return;
  }

  try {
    await botClient.conversations.info({ channel: destChannelId });
  } catch (err) {
    const code = err.data ? err.data.error : err.message;
    await ack({
      response_action: 'errors',
      errors: {
        dest_block: `I'm not in that channel yet (${code}). Invite me to it first, then try again.`,
      },
    });
    return;
  }

  await ack();

  // invite list — always strip the birthday person, even if someone manually added them
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

  const messageText = (messageInput || '').trim() || defaultMessage(birthdayUserId, inviterId);

  const buttonValue = JSON.stringify({
    dest: destChannelId,
    bday: birthdayUserId,
    inviter: inviterId,
  });

  const { sentIds, failures } = await sendInviteDms(client, toMessage, messageText, buttonValue);
  const sent = sentIds.length;

  if (sent) {
    birthdayStore.set(birthdayUserId, { date: birthdayDate, inviterId, destChannelId, message: messageText });
    birthdayStore.addInvites(birthdayUserId, sentIds);
  }

  const summaryLines = [
    `:yay: Successfully sent messages to ${sent} ${sent === 1 ? 'person' : 'people'} (based on <#${sourceChannelId}>) for <@${birthdayUserId}>'s birthday.`,
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

  // Hard stop: the birthday person must never be added to the planning channel,
  // no matter how they got this button (stale DM, forwarded message, etc.).
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
