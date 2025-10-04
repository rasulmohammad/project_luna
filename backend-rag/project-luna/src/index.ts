import { Hono } from "hono";

interface VectorQueryResult {
  id: string;
  score: number;
  values: number[];
  metadata: {
    text: string;
    source?: string;
  };
}

interface VectorizeIndex {
  query: (
    vector: number[],
    options: {
      topK: number;
      returnMetadata?: boolean;
    }
  ) => Promise<{ matches: VectorQueryResult[] }>;
}

interface Env {
  AI: {
    run: (
      model: string,
      input: { text?: string; messages?: { role: string; content: string }[]; max_tokens?: number }
    ) => Promise<any>;
  };
  VECTOR_INDEX: VectorizeIndex;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/message", (c) => c.text("Hello World!"));

// Main RAG endpoint
app.post("/rag", async (c) => {
  try {
    // 1️⃣ Parse JSON body
    const body = await c.req.json<{ question?: string }>();
    const userQuery = body.question?.trim();
    if (!userQuery) return c.json({ error: "Missing 'question' in request body" }, 400);

    console.log("Using query:", body);

    // 2️⃣ Generate embedding using Cloudflare AI
    const embeddingRaw = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: userQuery });
    console.log("Raw embedding response:", embeddingRaw);

    // 3️⃣ Extract embedding vector from possible response shapes
    const queryVector: number[] | undefined =
      Array.isArray((embeddingRaw as any).embedding)
        ? (embeddingRaw as any).embedding
        : Array.isArray((embeddingRaw as any).result?.embedding)
        ? (embeddingRaw as any).result.embedding
        : Array.isArray((embeddingRaw as any).data?.[0])
        ? (embeddingRaw as any).data[0]
        : undefined;

    if (!queryVector) return c.json({ error: "Failed to create embedding for the query." }, 500);

    console.log("Query vector length:", queryVector.length);

    // 4️⃣ Query the Vectorize index
    const searchResults = await c.env.VECTOR_INDEX.query(queryVector, {
      topK: 5,
      returnMetadata: true,
    });

    const contextChunks = searchResults.matches.map((m) => m.metadata.text).join("\n---\n");

    if (!contextChunks)
      return c.json({
        response: `I couldn't find any relevant info for "${userQuery}" in the knowledge base.`,
      });

    // 5️⃣ Prepare system prompt for LLM
    const systemInstruction = `
You are a helpful assistant powering a space biology knowledge engine.
Use the context below to answer the user's question.
If the answer is not present, clearly state that it is unavailable.
Context:
---
${contextChunks}
---
`;

    // 6️⃣ Generate final answer with LLM
    const llmResponse = (await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userQuery },
      ],
      max_tokens: 512,
    })) as { response: string };

    // 7️⃣ Return RAG response
    return c.json({
      query: userQuery,
      context_chunks: searchResults.matches.map((m) => ({ text: m.metadata.text, score: m.score })),
      final_answer: llmResponse.response?.trim() ?? "",
    });
  } catch (err) {
    console.error("RAG endpoint error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});



// Temporary debug endpoint for embeddings
// app.post("/rag-debug", async (c) => {
//   try {
//     const body = await c.req.json<{ question?: string }>();
//     const userQuery = body.question?.trim();

//     if (!userQuery) {
//       return c.json({ error: "Missing 'question' in request body" }, 400);
//     }

//     // Call the embedding model
//     const embeddingRaw = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: userQuery });

//     // Return the raw response for inspection
//     return c.json({
//       query: userQuery,
//       embeddingRaw,
//     });
//   } catch (err) {
//     return c.json({
//       error: "Failed to call embedding model",
//       details: String(err),
//     }, 500);
//   }
// });


export default app;
