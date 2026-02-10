// utils/blobStorage.js
const { BlobServiceClient } = require("@azure/storage-blob");


function getBlobServiceClient() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error("Missing AZURE_STORAGE_CONNECTION_STRING");
  return BlobServiceClient.fromConnectionString(cs);
}

// Reads JSON (e.g., Firebase service account) or plain text from Azure Blob
async function readCredFiles(containerName, fileName) {
    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(fileName);

    const resp = await blobClient.download(0);
    const data = await streamToBuffer(resp.readableStreamBody);
    const contentString = data.toString().trim();

    try {
        return JSON.parse(contentString); // JSON file
    } catch {
        return contentString;            // plain text file
    }
}

function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (d) =>
            chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d))
        );
        readableStream.on("end", () => resolve(Buffer.concat(chunks)));
        readableStream.on("error", reject);
    });
}

module.exports = { readCredFiles };
