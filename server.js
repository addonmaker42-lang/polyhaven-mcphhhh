import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));

const API = "https://api.polyhaven.com";
const headers = {
  "User-Agent": "PolyHaven-MCP/1.0"
};

async function apiGet(path) {
  const response = await fetch(API + path, {
    headers,
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Poly Haven API error: ${response.status}`);
  }

  return response.json();
}

function createServer() {
  const server = new McpServer({
    name: "polyhaven-3d-library",
    version: "1.0.0"
  });

  // TOOL 1: SEARCH MODELS
  server.registerTool(
    "search_3d_models",
    {
      description:
        "Search 3D models in the Poly Haven library. Returns names, descriptions, categories and previews.",
      inputSchema: {
        query: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(20).optional()
      }
    },
    async ({ query, limit = 10 }) => {
      const assets = await apiGet("/assets");
      const words = query.toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      const results = Object.entries(assets)
        .filter(([id, item]) => item.type === 2)
        .map(([id, item]) => {
          const searchable = [
            id,
            item.name,
            item.description,
            item.category,
            ...(item.tags || [])
          ].join(" ").toLowerCase();

          const score = words.reduce(
            (total, word) =>
              total + (searchable.includes(word) ? 1 : 0),
            0
          );

          return { id, item, score };
        })
        .filter(result => result.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            source: "Poly Haven",
            powered_by: "Poly Haven",
            query,
            results: results.map(({ id, item }) => ({
              id,
              name: item.name,
              description: item.description,
              category: item.category,
              tags: item.tags,
              thumbnail: item.thumbnail_url,
              polycount: item.polycount
            }))
          }, null, 2)
        }]
      };
    }
  );

  // TOOL 2: GET DOWNLOAD LINKS
  server.registerTool(
    "get_model_download_links",
    {
      description:
        "Get available downloadable files and formats for a Poly Haven 3D model.",
      inputSchema: {
        asset_id: z.string().regex(/^[a-zA-Z0-9_-]+$/)
      }
    },
    async ({ asset_id }) => {
      const files = await apiGet(
        "/files/" + encodeURIComponent(asset_id)
      );

      const downloads = [];

      function scan(object, path = "") {
        if (!object || typeof object !== "object") return;

        if (Array.isArray(object)) {
          object.forEach((value, index) =>
            scan(value, path + "/" + index)
          );
          return;
        }

        if (
          typeof object.url === "string" &&
          object.url.startsWith("https://")
        ) {
          const extension =
            object.url.split("?")[0].split(".").pop().toLowerCase();

          if (["glb", "gltf", "fbx", "obj", "blend", "usd", "abc"].includes(extension)) {
            downloads.push({
              file: path,
              format: extension,
              url: object.url,
              size_bytes: object.size ?? null
            });
          }
        }

        for (const [key, value] of Object.entries(object)) {
          scan(value, path ? path + "/" + key : key);
        }
      }

      scan(files);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            source: "Poly Haven",
            asset_id,
            downloads
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

// HEALTH CHECK
app.get("/", (req, res) => {
  res.send("Poly Haven MCP Server is running!");
});

// MCP ENDPOINT
app.post("/mcp", async (req, res) => {
  const mcp = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP server error"
      });
    }
  } finally {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Poly Haven MCP running on port ${PORT}`);
});
