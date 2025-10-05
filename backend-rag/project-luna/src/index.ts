import { Hono } from "hono";

interface VectorQueryResult {
  id: string;
  score: number;
  values: number[];
  metadata: {
    Title: string;
    Link: string;
    text: string;
  };
}

interface VectorizeIndex {
  query: (
    vector: number[],
    options: {
      topK: number;
      returnValues?: boolean;
      returnMetadata?: boolean;
    }
  ) => Promise<{ matches: VectorQueryResult[] }>;
}

interface Env {
  AI: {
    run: (
      model: string,
      input: {
        text?: string;
        messages?: { role: string; content: string }[];
        max_tokens?: number;
      }
    ) => Promise<any>;
  };
  VECTOR_INDEX: VectorizeIndex;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/message", (c) => c.text("Hello World!"));

// app.use("/*", async (c, next) => {
//   // Handle preflight requests
//   if (c.req.method === "OPTIONS") {
    
//   }

//   await next();

//   // Add CORS headers to all other responses
//   c.header("Access-Control-Allow-Origin", "*");
//   c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
//   c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
// });

app.options("/rag", (c) => {
  return c.text("OK", {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
});

// -------------------- Helper function --------------------
async function processTopMatches(
  env: Env,
  matches: VectorQueryResult[]
) {
  const ai = env.AI;

  // Only take the first 5 matches
  const topMatches = matches.slice(0, 5);
  console.log("LOGGING SOMETHING")
  console.log(topMatches.map(m => m.metadata));

  // Step 1: Summarize each match in parallel
  const summaries = await Promise.all(
    topMatches.map(async (m) => {
      console.log("THIS IS SUMMARIES", m);
      console.log("This is link: ", m.metadata.Link);
      console.log("This is title: ", m.metadata.Title);
      const summaryPrompt = `
Summarize the following passage in 2-3 sentences, focusing on the main ideas:

${m.metadata?.text || ""}
      `;
      const summaryResp = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          { role: "system", content: "You are a concise summarizer." },
          { role: "user", content: summaryPrompt },
        ],
      });

      return {
        Title: m.metadata.Title,
        Link: m.metadata.Link,
        score: m.score,
        summary: summaryResp.response?.trim() || summaryResp.result?.trim() || "",
      };
    })
  );

  // Step 2: Extract top 3 key terms from the combined summaries
  const combinedText = summaries.map((s) => s.summary).join("\n\n");
  const keywordsPrompt = `
Extract the top 3 most important key terms or concepts from the following text.
**Respond ONLY as a JSON array of strings. Do not include any explanations or extra text.**

${combinedText}
  `;

  let keyTerms: string[] = [];
  let keywordsResp: any;
  try {
    keywordsResp = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "You are a concise key term extractor." },
        { role: "user", content: keywordsPrompt },
      ],
    });
    keyTerms = JSON.parse(keywordsResp.response || keywordsResp.result || "[]");
  } catch {
    keyTerms = (keywordsResp.response || keywordsResp.result || "")
      .split(",")
      .map((k: string) => k.trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  return { top_matches: summaries, key_terms: keyTerms };
}

// -------------------- Main RAG Endpoint --------------------
app.post("/rag", async (c) => {
  try {
    console.log("VERIFYING BEHAVIOR");
    const { question } = await c.req.json();

    console.log("QUESTION", question);
    
    if (!question || typeof question !== "string") {
      return c.json({ error: "Missing or invalid 'question' in request body." }, 400);
    }

    // Step 1: Create embedding
    const embeddingResp = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: question });
    const rawEmbedding =
      (embeddingResp as any).embedding ||
      (embeddingResp as any).result?.embedding ||
      (embeddingResp as any).data?.[0];
    const queryEmbedding = Array.isArray(rawEmbedding?.[0]) ? rawEmbedding[0] : rawEmbedding;

    if (!Array.isArray(queryEmbedding)) {
      return c.json({ error: "Failed to create embedding for the query." }, 500);
    }

    // Step 2: Query Vectorize index (top 5)
    const vectorResults = await c.env.VECTOR_INDEX.query(queryEmbedding, {
      topK: 5,
      returnValues: true,
      returnMetadata: true,
    });
    const matches = vectorResults.matches || [];

    if (matches.length === 0) {
      return c.json({
        query: question,
        final_answer: "No relevant information found in the knowledge base.",
        top_matches: [],
        key_terms: [],
      });
    }

    // Step 3: Generate final answer with context
    const contextText = matches
      .map((m) => m.metadata?.text || "")
      .filter((t) => t.length > 0)
      .join("\n---\n");
    
    console.log("CONTEXT", contextText)
    
    const answerPrompt = `
You are an AI research assistant. Use the provided context to answer the user question clearly and precisely.
If the context is insufficient or empty, say "I don’t have enough information to answer confidently."

Context:
${contextText}

Question: ${question}
`;

    const aiResponse = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "You are a helpful research assistant." },
        { role: "user", content: answerPrompt },
      ],
    });

    const finalAnswer =
      aiResponse?.response || aiResponse?.result || "No answer generated.";

    // Step 4: Process top matches for summaries + key terms
    const processedData = await processTopMatches(c.env, matches);
    console.log("ProcessedData here", processedData);

    // Step 5: Return final JSON for frontend
    console.log("This is the JSON", c.json({
      query: question,
      final_answer: finalAnswer,
      ...processedData,
    }));

    const res = { query: question, final_answer: finalAnswer, ...processedData }

    return c.json(res, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    // return c.json({
    //   query: question,
    //   final_answer: finalAnswer,
    //   ...processedData,
    // });
  } catch (err) {
    console.error("❌ RAG endpoint failed:", err);
    return c.json({ error: "Internal server error in /rag." }, 500);
  }
});

export default app;
