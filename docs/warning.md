# smol warning for ya

Connecting your slack account to this bot means it generated a 
personal Slack access token tied to your account.

## What it can do

- Read the name, topic, and full member list of every channel you are in.

## What it can't do

- everything not mentioned in the can do section

## Why?

This bot is only able to pull the lits of people in public channels and all ping groups. This means that if you want to invite people from a private channel (i.e. they have a private channel of personal friends), the bot will not be able to see who is that channel. Alternatively, if the brirthday planning channel is private (i mean why wouldnt it be>) the same applies to the bot. To fix this, I've made a way to go through a hc + slack auth flow to give this bot your personal slack token to ONLY read the members of private channels you are in. That's it!

## How to revoke it

- Run `/unlink-bdaypheus` in Slack to remove the token. 
- Revoke it by going into Slack → your apps → Bday Bot → Remove

After revoking, the next time the bot needs to read a private channel
you're in, you'll just be prompted to connect again.