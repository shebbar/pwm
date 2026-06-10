import "dotenv/config";
import { initDatabase } from "./db.js";

initDatabase()
  .then(() => {
    console.log("Migrations applied.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
