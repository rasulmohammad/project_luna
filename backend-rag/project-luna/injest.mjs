import * as fs from "node:fs/promises";
import { configDotenv } from "dotenv";
import parse from 'csv-parser'
import { json, text } from "node:stream/consumers";

configDotenv();

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const VECTORIZE_INDEX_NAME='vector-index'
const EMBEDDING_MODEL='@cf/baai/bge-base-en-v1.5'
const CSV_FILE_PATH='./articles.csv'

async function loadCsv(filePath) {
    const data = []
    const fileContent = await fs.readFile(filePath, 'utf-8');

    return new Promise((resolve, reject) => {
        const stream = parse()
        .on('data', (row) => {
            // console.log("This is the row:", row)
            const chunkText = Object.entries(row)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' | ');

            // console.log(chunkText)
             data.push( {
                text: chunkText,
                metadata: {
                  Title: row.Title,
                  Link: row.Link,
                  text: row.text.slice(0, 1000)
                },
            });

            // console.log("Latest entry to data: ", data[data.length - 1]);
        })
        .on('end', () => resolve(data))
        .on('error', reject);

        stream.write(fileContent);
        stream.end();
    });
}

async function getEmbeddings(texts) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: texts }),
        });

        if (!response.ok) {
            throw new Error(`API Call Failed: ${response.statusText}`);
        }

        const result = await response.json();
        return result.result.data;
    } catch (error) {
        console.error("Error generating embeddings: ", error);
        return [];
    }
}

async function insertVectors(vectors) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX_NAME}/upsert`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            namespace: "default", // optional, but recommended
            vectors: vectors.map(v => ({
              id: v.id,
              values: v.values,
              metadata: v.metadata,
            })),
          }),
        }
      );
  
      const data = await response.json();
  
      if (!response.ok) {
        throw new Error(
          `Vectorize Upsert failed: ${
            data.errors ? JSON.stringify(data.errors) : data.message
          }`
        );
      }
  
      console.log("✅ Inserted vectors successfully:", data);
      return data.result;
    } catch (error) {
      console.error("❌ Error inserting vectors:", error);
    }
  }
  

async function main() {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        console.error("Please set CF_ACCOUNT_ID and CF_API_TOKEN environment variables.");
        return;
    }

    console.log(`1. Loading data from ${CSV_FILE_PATH}...`);
    const allData = await loadCsv(CSV_FILE_PATH);
    console.log(`   - Loaded ${allData.length} records.`);

    const BATCH_SIZE = 50; // Use a reasonable batch size for the AI API
    const vectorsToUpsert = [];

    for (let i = 0; i < allData.length; i += BATCH_SIZE) {
        const batch = allData.slice(i, i + BATCH_SIZE);
        const batchTexts = batch.map(d => d.text);
        const batchMetadata = batch.map(d => d.metadata);

        console.log(`2. Generating embeddings for batch ${i / BATCH_SIZE + 1} (${batch.length} items)...`);
        const embeddings = await getEmbeddings(batchTexts);

        if (embeddings.length === 0) {
            console.error(`   - FATAL ERROR: Skipping remainder due to failed embeddings in batch ${i}. Check logs for details.`);
            break; 
        }

        if (embeddings.length !== batch.length) {
            console.warn(`   - Warning: Embedding count mismatch in batch ${i}. Skipping batch.`);
            continue;
        }

        // 3. Structure data for Vectorize upsert API
        const formattedVectors = embeddings.map((embedding, index) => ({
            id: `doc-${i + index}`, // Ensure unique ID for each row
            values: embedding,
            metadata: batchMetadata[index],
        }));
        
        vectorsToUpsert.push(...formattedVectors);
        console.log(`   - Batch ${i / BATCH_SIZE + 1} completed.`);
    }

    if (vectorsToUpsert.length === 0) {
        console.error("❌ Cannot proceed with upsert: No vectors were generated successfully.");
        return;
    }

    // 4. Perform the final bulk upsert to Vectorize
    console.log(`3. Upserting ${vectorsToUpsert.length} total vectors to Vectorize...`);
    const upsertResult = await insertVectors(vectorsToUpsert);

if (upsertResult && upsertResult.mutationId) {
  console.log(`✅ Success! Mutation ID: ${upsertResult.mutationId}`);
} else {
  console.error("❌ Final upsert failed. Response:", upsertResult);
}

}

main().catch(console.error);

// Error inserting vectors: Error: Vectorize Upsert failed: Bad Request. Body: {
//     "result": null,
//     "success": false,
//     "errors": [
//       {
//         "code": 1005,
//         "message": "vectorize.unknown_content_type"
//       }
//     ],
//     "messages": []
//   }
  
//       at insertVectors (file:///Users/rasulmohammad/Desktop/personal_projects/project_luna/backend-rag/project-luna/injest.mjs:77:19)
//       at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
//       at async main (file:///Users/rasulmohammad/Desktop/personal_projects/project_luna/backend-rag/project-luna/injest.mjs:129:26)
//   ❌ Final upsert failed.

// packages: project_luna/backend-rag/project-luna
// ├── csv-parser@3.2.0
// ├── dotenv@17.2.3
// ├── hono@4.9.9
// └── wrangler@4.42.0
