import express from "express";

const app = express();
const port = 4317;

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Job Post Email Tracker service listening on http://localhost:${port}`);
});
