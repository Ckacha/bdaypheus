## Slack app

https://api.slack.com/app, create app and give it the following perms 

- commands
- chat:write
- im:write
- channels:read
- groups:read
- channels:manage
- groups:write
- users:read
- usergroups:read

Also make sure to turn on **Socket Mode**, **Interactivity**, and **Shortcuts**.

### Slash commands

- `/bdaypheus`
- `/link-bdaypheus` 
- `/unlink-bdaypheus` 
- `/send-reminders`

## .env setup

SLACK_BOT_TOKEN=xoxb-
SLACK_APP_TOKEN=xapp-
SLACK_SIGNING_SECRET=

##  Running

npm install
npm start

Should work afterwards!
