import { env } from "./config/env";
import { App } from "./app";
import { modules } from "./modules";

const PORT = Number(env.PORT);

const app = new App(modules, PORT);

app.listen().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
