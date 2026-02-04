import "dotenv/config";
import pkg from "@slack/bolt";
import { registerHandlers } from "./handlers.js";

const { App } = pkg;

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

registerHandlers(app);