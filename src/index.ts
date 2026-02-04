import { app } from "./slack/app.js";

(async () => {
  await app.start();
  console.log("⚡️ Markup bot running (listening for app_mention)");
})();