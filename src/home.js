const messages = {
  connected: "You're connected! Head back to Slack. If you had the /bdaypheus form open, close it and run /bdaypheus again.",
  revoked: 'Your token was revoked and deleted. You can link again any time.',
  loggedOut: "You're logged out on this browser. Your Slack account is still linked.",
  expired: 'That sign-in link expired. Press Log in with Slack to start again.',
  hackclub: "Hack Club Auth didn't confirm who you are. Try again.",
  slack: "Slack didn't finish connecting your account. Try again.",
  cancelled: 'Slack sign-in was cancelled.',
  disabled: "Linking isn't set up on this server yet.",
};

const notice = document.getElementById('notice');
const signedOut = document.getElementById('signed-out');
const signedIn = document.getElementById('signed-in');
let csrf = null;

function showNotice(key, isError) {
  if (!messages[key]) return;
  notice.textContent = messages[key];
  notice.classList.toggle('error', Boolean(isError));
  notice.hidden = false;
}

function showState(state) {
  signedIn.hidden = !state.connected;
  signedOut.hidden = state.connected;
  document.getElementById('who').textContent = state.connected && state.name ? ` as ${state.name}` : '';
  csrf = state.csrf || null;
}

async function post(path) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Bdaypheus-CSRF': csrf || '' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const params = new URLSearchParams(location.search);
if (params.get('connected')) showNotice('connected');
if (params.get('error')) showNotice(params.get('error'), true);
if (params.toString()) history.replaceState(null, '', location.pathname);

fetch('/connect/me', { credentials: 'same-origin' })
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
  .then(showState)
  .catch(() => {});

document.getElementById('revoke').addEventListener('click', async (event) => {
  if (!confirm('Revoke your Bdaypheus token? You can link again any time.')) return;
  event.target.disabled = true;
  try {
    const result = await post('/connect/revoke');
    showState({ connected: false });
    if (result.revokeFailure) {
      notice.textContent =
        `Your token was deleted from Bdaypheus, but Slack didn't confirm cancelling it (${result.revokeFailure}). ` +
        'To be safe, remove Bday Bot under your Slack apps.';
      notice.classList.add('error');
      notice.hidden = false;
    } else {
      showNotice('revoked');
    }
  } catch (err) {
    notice.textContent = "Couldn't revoke right now. Try again, or run /unlink-bdaypheus in Slack.";
    notice.classList.add('error');
    notice.hidden = false;
  } finally {
    event.target.disabled = false;
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  try {
    await post('/connect/logout');
  } catch (err) {}
  showState({ connected: false });
  showNotice('loggedOut');
});
