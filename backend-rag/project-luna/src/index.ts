import { Hono } from "hono";

interface AIEmbeddingInput {
  text: string | string[];
}

interface VectorQueryResult {
  id: string;
  score: number;
  values: number[];
  metadata: {
      text: string;
      source: string;
  };
}

interface VectorizeIndex {
  query: (
      vector: number[],
      options: {
          topK: number;
          filter?: Record<string, unknown>;
          returnValues?: boolean; // Set to true to get vectors back
          returnMetadata?: boolean; // Set to true to get metadata back
      }
  ) => Promise<{ matches: VectorQueryResult[] }>;
}

interface Message {
  role: "user" | "system" | "assistant" | "tool";
  content: string;
}

// Define the input structure for a chat model call
interface AITextGenerationInput {
  messages: Message[];
  // Include other potential optional parameters common to LLMs
  stream?: boolean;
  max_tokens?: number;
}

interface Env {
  // 1. Define the AI binding with a more precise run signature.
  AI: {
    run: (
      model: string,
      inputs: AIEmbeddingInput | AITextGenerationInput | Record<string, unknown>
    ) => Promise<{ response: string; embedding: number[] } | Record<string, unknown>>;
  };
  VECTOR_INDEX: VectorizeIndex;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/message", (c) => {
  return c.text("Hello World!");
});

app.get("/hello-ai", async (c) => {
  const results = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      {"role":"user", "content":"Explain what NASA is in two sentences."}
    ]
  })
  return c.json(results);
});

app.get("/rag", async (c) => {
  const userQuery = "Summarize what these articles are about."

  const embeddingResponse  =await c.env.AI.run(
    "@cf/baai/bge-base-en-v1.5",
    {text:userQuery}
  ) as {embedding: number[]};

  if (!embeddingResponse.embedding) {
    return c.json({error: "Failed to create embedding for the query."}, 500)
  }

  const queryVector = embeddingResponse.embedding;

  const searchResults = await c.env.VECTOR_INDEX.query(queryVector, {
    topK: 5,
    returnMetadata: true,
  });

  const context = searchResults.matches
  .map(match => match.metadata.text)
  .join("\n---\n");

  if (!context) {
    return c.json({response: `I coulnd't find any specific information related to "${userQuery}" in my knowledge base`})
  }

  const systemInstruction =
  `You are a helpful assistant powering a space biology knowledge engine. Use the following context to answer the user's question. 
        If you cannot find the answer in the context, clearly state that the answer is not available in the provided data. 
        Context:
        ---
        ${context}
        ---`;

        const llmResponse = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [
              { role: "system", content: systemInstruction },
              { role: "user", content: userQuery }
          ],
          max_tokens: 512,
      }) as { response: string };

      return c.json({
        query: userQuery,
        context_chunks: searchResults.matches.map(m => ({ text: m.metadata.text, score: m.score })),
        final_answer: llmResponse.response.trim(),
    });
});

export default app;
