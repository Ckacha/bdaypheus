# bday-bot
Slack bot to invite people to birthday card channels!

Uhh people annoyed about being added to many bday card channels and here is my solution

## How to set up:

Check [setup.md](docs/setup.md) for how to set up, ideally you wouldn't need to do this since the bot should be up 24/7.
If it is down, dm [@iamalive](https://hackclub.slack.com/team/U0828FYS2UC) on slack!

## Usable Commands

/bdaypheus
    Model to invite people from a user group/channel to another channel for birthday planning

/link-bdaypheus
    Used to link your slack account to add people from private channels(check the part below for why this is)

/unlink-bdaypheus
    Used to unlink your slack account and get rid of your personal token(check [warning.md](docs/warning.md) fur full explanation)

/send-reminders [@birthday person]
    Re-sends the invite to everyone who hasn't accepted or declined yet. (only the original inviter can do this)

## Private channels

Becuase adding a bot literally named Bdaypheus would be pretty sus to a person's personal channel, and getting admins perms would be annoying, 
I've come up with the idea of using hc auth to get your user token so it can invite the people from a person's personal private channel!

# SMALL NOTE:

Please understand that by using the login method, you're going to generate a slack user token which will have certain permissions, check [warning.md](docs/warning.md) for the full explanation.

