import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Set up bodies up to 20MB for PDF/Image uploads
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// Lazy initializer for Gemini client
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY" || key.trim() === "") {
      throw new Error("GEMINI_API_KEY environment variable is missing or blank in Settings > Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// -------------------------------------------------------------
// API Endpoint: Analyze Document (PDF or Image)
// -------------------------------------------------------------
app.post("/api/analyze-file", async (req, res) => {
  try {
    const { fileData, mimeType, fileName } = req.body;
    if (!fileData || !mimeType) {
      return res.status(400).json({ error: "Missing fileData or mimeType" });
    }

    const ai = getGenAI();

    // Prompts Gemini to parse the PDF/image as a medical document
    const systemInstruction = 
      "You are an expert clinical pharmacologist. Analyze the provided medical document (prescription, medical report, or lab test) " +
      "and extract: 1) The standard clinical names of all active medications, along with their dosages and frequencies. " +
      "2) Any clinically significant drug-to-drug interactions among these extracted medications. " +
      "If there are no interactions, return an empty interactions array. " +
      "Formulate your response in clean, Vietnamese language, especially drug descriptions, interaction danger labels, and clinical explanations.";

    const schema = {
      type: Type.OBJECT,
      properties: {
        fileName: { type: Type.STRING },
        drugs: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: "Standard clinical name of the drug, e.g. Metformin Hydrochloride" },
              dosage: { type: Type.STRING, description: "Dosage, e.g. 500mg" },
              frequency: { type: Type.STRING, description: "Frequency or note, e.g. 2 lần/ngày (Sáng/Tối)" }
            },
            required: ["name"]
          }
        },
        interactions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: { type: Type.STRING, description: "Must be 'CRITICAL' (Nghiêm trọng) or 'MODERATE' (Trung bình) or 'MINOR' (Nhẹ/Theo dõi)" },
              drugs: { type: Type.STRING, description: "The pair of interacting drugs, e.g. Lisinopril ↔ Ibuprofen" },
              description: { type: Type.STRING, description: "Detailed medical explanation in Vietnamese of why they interact and key clinical recommendations" }
            },
            required: ["severity", "drugs", "description"]
          }
        }
      },
      required: ["drugs", "interactions"]
    };

    let response;
    let modelUsed = "gemini-3.5-flash";
    try {
      console.log(`Attempting analysis with primary model: ${modelUsed}`);
      response = await ai.models.generateContent({
        model: modelUsed,
        contents: [
          {
            inlineData: {
              data: fileData,
              mimeType: mimeType
            }
          },
          {
            text: `Please parse this file named "${fileName || 'document.pdf'}". Extract medications and analyze their drug-to-drug interactions.`
          }
        ],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      });
    } catch (primaryError: any) {
      console.error("Primary model analysis error:", primaryError);
      const errString = String(primaryError?.message || primaryError?.status || JSON.stringify(primaryError) || primaryError);
      const isQuota = errString.includes("429") || errString.toLowerCase().includes("quota") || errString.toLowerCase().includes("limit") || errString.toLowerCase().includes("exhausted") || errString.toLowerCase().includes("resource_exhausted");
      
      if (isQuota) {
        modelUsed = "gemini-3.1-flash-lite";
        console.warn(`Primary model quota exceeded. Falling back to alternative model: ${modelUsed}`);
        try {
          response = await ai.models.generateContent({
            model: modelUsed,
            contents: [
              {
                inlineData: {
                  data: fileData,
                  mimeType: mimeType
                }
              },
              {
                text: `Please parse this file named "${fileName || 'document.pdf'}". Extract medications and analyze their drug-to-drug interactions.`
              }
            ],
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: schema
            }
          });
        } catch (fallbackError: any) {
          console.error("Fallback model check also failed:", fallbackError);
          throw fallbackError;
        }
      } else {
        throw primaryError;
      }
    }

    const textResult = response.text;
    if (!textResult) {
      throw new Error("No output text returned from model.");
    }

    const parsedData = JSON.parse(textResult);
    return res.json({
      success: true,
      data: {
        fileName: fileName || parsedData.fileName || "document.pdf",
        drugs: parsedData.drugs || [],
        interactions: parsedData.interactions || [],
        modelUsed: modelUsed
      }
    });

  } catch (error: any) {
    console.error("Error analyzing file in backend:", error);
    const errMsg = typeof error === "object" && error !== null ? (error.message || JSON.stringify(error)) : String(error);
    const isQuota = errMsg.includes("429") || errMsg.toLowerCase().includes("quota") || errMsg.toLowerCase().includes("limit") || errMsg.toLowerCase().includes("exhausted");
    return res.status(isQuota ? 200 : 500).json({
      success: false,
      quotaExceeded: isQuota,
      error: isQuota 
        ? "Gemini API Quota Exceeded (429). Switching seamlessly to local medical heuristic parser." 
        : (error.message || "An error occurred during file analysis.")
    });
  }
});


// -------------------------------------------------------------
// API Endpoint: Custom check / update of interactions
// -------------------------------------------------------------
app.post("/api/check-interactions", async (req, res) => {
  try {
    const { drugs } = req.body;
    if (!drugs || !Array.isArray(drugs)) {
      return res.status(400).json({ error: "Invalid 'drugs' parameter. Must be an array." });
    }

    if (drugs.length < 2) {
      return res.json({ success: true, data: { interactions: [] } });
    }

    const ai = getGenAI();

    const systemInstruction =
      "You are an expert medical pharmacologist checking drug-to-drug interactions. " +
      "Identify all clinically documented interactions among the list of medications provided. " +
      "Explain the severity (CRITICAL, MODERATE, or MINOR) and mechanism/recommendation clearly in Vietnamese.";

    const schema = {
      type: Type.OBJECT,
      properties: {
        interactions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: { type: Type.STRING, description: "CRITICAL or MODERATE or MINOR" },
              drugs: { type: Type.STRING, description: "e.g. DrugA ↔ DrugB" },
              description: { type: Type.STRING, description: "Clinical description and advice in Vietnamese" }
            },
            required: ["severity", "drugs", "description"]
          }
        }
      },
      required: ["interactions"]
    };

    const drugListText = drugs.map(d => `${d.name} (${d.dosage || "N/A"} - ${d.frequency || "N/A"})`).join(", ");

    let response;
    let modelUsed = "gemini-3.5-flash";
    try {
      console.log(`Attempting medical interaction check with primary model: ${modelUsed}`);
      response = await ai.models.generateContent({
        model: modelUsed,
        contents: `Please verify if there are any clinically significant interactions in this list of medications: ${drugListText}.`,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      });
    } catch (primaryError: any) {
      console.error("Primary model interaction checking error:", primaryError);
      const errString = String(primaryError?.message || primaryError?.status || JSON.stringify(primaryError) || primaryError);
      const isQuota = errString.includes("429") || errString.toLowerCase().includes("quota") || errString.toLowerCase().includes("limit") || errString.toLowerCase().includes("exhausted") || errString.toLowerCase().includes("resource_exhausted");
      
      if (isQuota) {
        modelUsed = "gemini-3.1-flash-lite";
        console.warn(`Primary model quota exceeded. Falling back to alternative model: ${modelUsed}`);
        try {
          response = await ai.models.generateContent({
            model: modelUsed,
            contents: `Please verify if there are any clinically significant interactions in this list of medications: ${drugListText}.`,
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: schema
            }
          });
        } catch (fallbackError: any) {
          console.error("Fallback model check also failed:", fallbackError);
          throw fallbackError;
        }
      } else {
        throw primaryError;
      }
    }

    const textResult = response.text;
    if (!textResult) {
      throw new Error("No output text returned from model.");
    }

    const parsedData = JSON.parse(textResult);
    return res.json({
      success: true,
      data: {
        interactions: parsedData.interactions || [],
        modelUsed: modelUsed
      }
    });

  } catch (error: any) {
    console.error("Error checking interactions in backend:", error);
    const errMsg = typeof error === "object" && error !== null ? (error.message || JSON.stringify(error)) : String(error);
    const isQuota = errMsg.includes("429") || errMsg.toLowerCase().includes("quota") || errMsg.toLowerCase().includes("limit") || errMsg.toLowerCase().includes("exhausted");
    return res.status(isQuota ? 200 : 500).json({
      success: false,
      quotaExceeded: isQuota,
      error: isQuota
        ? "Gemini API Quota Exceeded (429). Switching seamlessly to local interaction heuristics."
        : (error.message || "An error occurred during interaction checking.")
    });
  }
});


// -------------------------------------------------------------
// Vite Middleware / Static Asset Serving
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode with Vite HMR integration...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in production mode serving static assets...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // SPA fallback
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on target port ${PORT}`);
    console.log(`Access standard local/preview through reverse proxy`);
  });
}

startServer();
