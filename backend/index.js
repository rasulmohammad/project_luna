import express from "express";
import fs from "fs";
import csv from "csv-parser";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Load CSV (only first 5 rows for testing)
let articles = [];
fs.createReadStream("articles.csv")
  .pipe(csv())
  .on("data", (row) => {
    if (articles.length < 5) articles.push({Title: row.title, Link: row.url}); // small subset
  })
  .on("end", () => {
    console.log("CSV loaded:", articles.length, "articles");
  });

// Simple RAG endpoint
app.post("/ask", async (req, res) => {
  const { question } = req.body;

  if (!question) return res.status(400).json({ error: "Missing question" });

  try {
    // 1. Find relevant articles (simple substring search for now)
    const results = articles
    .filter(article => article.title && article.title.toLowerCase().includes(question.toLowerCase()))
    .slice(0, 5);
  

    // 2. Send prompt to WorkerAI
    const prompt = `
      Question: ${question}
      Use these articles as context:
      ${results.map(a => `${a.title} - ${a.url}`).join("\n")}
    `;

    const response = await axios.post(
      "https://api.worker.ai/llm", // adjust if your endpoint differs
      { prompt },
      { headers: { Authorization: `Bearer ${process.env.CF_API_KEY}` } }
    );

    res.json({ answer: response.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching answer" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
