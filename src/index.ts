import "dotenv/config";
import { App } from "./app";
import { modules } from "./modules";

const PORT = Number(process.env.PORT || 3000);

const app = new App(modules, PORT);

app.listen().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
