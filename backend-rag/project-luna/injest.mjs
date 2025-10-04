import * as fs from "node:fs/promises";
import { configDotenv } from "dotenv";
import parse from 'csv-parser'
import { json, text } from "node:stream/consumers";

configDotenv();

const CLOUDFLARE_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CF_API_TOKEN;
const VECTORIZE_INDEX_NAME='vector-index'
const EMBEDDING_MODEL='@cf/baai/bge-base-en-v1.5'
const CSV_FILE_PATH='./articles.csv'

async function loadCsv(filePath) {
    const data = []
    const fileContent = await fs.readFile(filePath, 'utf-8');

    return new Promise((resolve, reject) => {
        const stream = parse()
        .on('data', (row) => {
            const chunkText = Object.entries(row)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' | ');

            data.push( {
                text: chunkText,
                metadata: row,
            });
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
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/vectorize/indexes/${VECTORIZE_INDEX_NAME}/upsert`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(vectors),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Vectorize Upsert failed: ${response.statusText}. Body: ${errorBody}`);
        }

        const result = await response.json();
        return result;
    } catch (error) {
        console.error("Error inserting vectors:", error);
        return null;
            
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

    // 4. Perform the final bulk upsert to Vectorize
    console.log(`3. Upserting ${vectorsToUpsert.length} total vectors to Vectorize...`);
    const upsertResult = await insertVectors(vectorsToUpsert);

    if (upsertResult?.count) {
        console.log(`✅ Success! Inserted/updated ${upsertResult.count} vectors.`);
    } else {
        console.log("❌ Final upsert failed.");
    }
}

main().catch(console.error);
